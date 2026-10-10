/**
 * Sessions: a conversation with Sai on one computer. Sai decides every click.
 *
 * Maps to `/v1/agents/*`: `new-session`, `message` (wait=false), `events`,
 * `approve`, `abort`. Every message is a run (`/v1/runs`); a message with a
 * contract (inputs, output schema, success criteria) is a structured run.
 */

import { ConflictError, LinkOnlyApprovalError, NotFoundError, RateLimitError } from './errors.js'
import type { Http } from './http.js'
import { idOf, type MachineRef, type Machines } from './machines.js'
import {
  parseApproval,
  parseEvent,
  parseRun,
  parseUsage,
  type Approval,
  type Attachment,
  type Check,
  type Event,
  type Run,
  type RunStatus,
  type TurnResult,
  type TurnStatus,
} from './types.js'

/**
 * What an `onApproval` handler answers: a response (`yes`, `no`, `task`), a
 * `[response, selections]` pair for a choice, or null to leave the approval
 * pending (e.g. a human answers it in a browser).
 */
export type ApprovalAnswer = string | [string, string[][]] | null
export type ApprovalHandler = (approval: Approval) => ApprovalAnswer | Promise<ApprovalAnswer>

export interface SendOptions {
  /** An id from `sai.models.list()` (or `auto`); sticks to the session until changed. */
  model?: string
  attachments?: Attachment[]
  /** Values for the `{{name}}` placeholders in the message. Makes the message a structured run. */
  inputs?: Record<string, string | number | boolean>
  /** JSON Schema (at most 32 KB) the run's output must match. Makes the message a structured run. */
  outputSchema?: Record<string, unknown>
  /**
   * A guideline for a judge, or yes/no checks, the turn is checked against.
   * Makes the message a structured run.
   */
  successCriteria?: string | Check[]
  /** The same key again returns the earlier run and sends nothing. Makes the message a structured run. */
  idempotencyKey?: string
  /** Keep a screenshot and the action for each step (`sai.runs.trajectory()`). */
  recordTrajectory?: boolean
  /** Applies to `sai.runs.create()`: keep the machine when the structured run's turn ends. */
  keepLockAtTurnEnd?: boolean
}

export interface WaitOptions {
  onApproval?: ApprovalHandler
  /** Throws a `TimeoutError` (DOMException) with the turn still running. */
  timeoutMs?: number
  /** Seconds the server may hold one poll; it caps at 60. */
  pollWait?: number
}

const POLL_WAIT = 30
/** Between run reads; `GET /v1/runs/{id}` never holds. */
const RUN_POLL_INTERVAL_MS = 2_000

interface EventsPage {
  sessionId?: string
  status?: TurnStatus
  events?: Record<string, unknown>[]
  text?: string
  cursor?: string
  approval?: Record<string, unknown>
  usage?: unknown
  sessionUsage?: unknown
}

export class Sessions {
  constructor(
    private readonly http: Http,
    private readonly machines: Machines,
  ) {}

  /**
   * Start a fresh conversation on a computer: the next message has no memory
   * of earlier ones. `machine` may be omitted with one computer.
   */
  async create(opts: { machine?: MachineRef } = {}): Promise<Session> {
    const machineId = await this.machines.resolveId(opts.machine)
    let sessionId: string | null = null
    try {
      const d = await this.http.json<{ sessionId?: string }>('POST', '/v1/agents/new-session', {
        json: { machineId, channel: 'api' },
      })
      sessionId = d.sessionId ?? null
    } catch (err) {
      // A free account's computer between claims has no conversation to
      // rotate; the first message starts one.
      if (!(err instanceof NotFoundError)) throw err
    }
    return new Session(this.http, machineId, sessionId)
  }

  /** Reattach to a session started elsewhere, e.g. to poll or abort it. */
  resume(sessionId: string, opts: { machine?: MachineRef } = {}): Session {
    return new Session(this.http, opts.machine ? idOf(opts.machine) : null, sessionId)
  }
}

/** A conversation with Sai. Each `send()` is a turn; turns share context. */
export class Session {
  constructor(
    private readonly http: Http,
    public machineId: string | null,
    public id: string | null,
  ) {}

  /**
   * Give Sai a task, or steer the running one. Returns at once. Sent while a
   * turn is running, the message steers that turn (`turn.queued` is true).
   *
   * Any of `inputs`, `outputSchema`, `successCriteria` or `idempotencyKey`
   * makes the message a structured run: the message is a template whose
   * `{{name}}` placeholders are filled from `inputs`, the output must match
   * `outputSchema`, and the turn is checked against `successCriteria`.
   * `wait()` then also returns the run's result in `result.run`. A structured
   * run is refused with `ConflictError` (`session_busy`) while a turn is running.
   */
  async send(message: string, opts: SendOptions = {}): Promise<Turn> {
    const body: Record<string, unknown> = { message, wait: false }
    if (this.machineId) body.machineId = this.machineId
    if (this.id) body.sessionId = this.id
    if (opts.model) body.model = opts.model
    if (opts.attachments?.length) body.attachments = opts.attachments.map((a) => a.raw)
    if (opts.inputs !== undefined) body.inputs = opts.inputs
    if (opts.outputSchema !== undefined) body.output_schema = opts.outputSchema
    if (opts.successCriteria !== undefined) body.success_criteria = opts.successCriteria
    if (opts.idempotencyKey !== undefined) body.idempotency_key = opts.idempotencyKey
    if (opts.recordTrajectory) body.recordTrajectory = true
    if (opts.keepLockAtTurnEnd) body.keepLockAtTurnEnd = true
    const structured = [
      opts.inputs,
      opts.outputSchema,
      opts.successCriteria,
      opts.idempotencyKey,
    ].some((v) => v !== undefined)
    const d = await this.http.json<Record<string, unknown>>('POST', '/v1/agents/message', {
      json: body,
    })
    if (d.idempotent_replay) {
      // The key was used before: this is that run, and nothing was sent.
      const run = parseRun(d)
      this.id = run.sessionId ?? this.id
      this.machineId = run.machineId || this.machineId
      return new Turn(this, this.http, false, null, {
        runId: run.id,
        structured: true,
        replay: run,
      })
    }
    if (typeof d.sessionId !== 'string' || !d.sessionId) {
      // Handled without starting a task (e.g. a plain acknowledgement): the reply is in `error`.
      const text = typeof d.error === 'string' ? d.error : ''
      return new Turn(this, this.http, false, localResult(this.id ?? '', text))
    }
    this.id = d.sessionId
    if (typeof d.machineId === 'string') this.machineId = d.machineId
    const runId = typeof d.runId === 'string' ? d.runId : null
    return new Turn(this, this.http, Boolean(d.queued), null, { runId, structured })
  }

  /** `send()` then `wait()`: the answer, or where it stopped. */
  async run(message: string, opts: SendOptions & WaitOptions = {}): Promise<TurnResult> {
    const turn = await this.send(message, opts)
    return turn.wait(opts)
  }

  /** Stop the running turn. Pending approvals are denied. False if nothing was running. */
  async abort(): Promise<boolean> {
    if (!this.id) return false
    const d = await this.http.json<{ aborted?: boolean }>('POST', '/v1/agents/abort', {
      json: { sessionId: this.id },
    })
    return Boolean(d.aborted)
  }

  /**
   * Answer an approval: `yes`, `no`, or `task` (allow for the rest of the task).
   * A `choice` approval needs `selections`, one list of option values per
   * question. Throws `LinkOnlyApprovalError` (with `approvalUrl`) when only a
   * browser can answer it. Resolves to `approved`, `approved_task` or `denied`.
   */
  async respond(
    approval: Approval | string,
    response = 'yes',
    opts: { selections?: string[][] } = {},
  ): Promise<string> {
    if (typeof approval !== 'string' && approval.isLinkOnly) {
      throw new LinkOnlyApprovalError(
        'This approval must be completed in a browser. Open approval.url.',
        { status: 409, code: 'link_only', body: { approvalUrl: approval.url } },
      )
    }
    const body: Record<string, unknown> = {
      approvalId: typeof approval === 'string' ? approval : approval.id,
      response,
    }
    if (opts.selections) body.selections = opts.selections
    const d = await this.http.json<{ status?: string }>('POST', '/v1/agents/approve', {
      json: body,
    })
    return d.status ?? ''
  }
}

/**
 * One message's work (a run). Iterate `events()` to watch it, or `wait()` for
 * the result. `runId` names the run (`sai.runs.get(turn.runId)`); null when the
 * message was answered without starting a task.
 */
export class Turn {
  readonly runId: string | null
  private cursor: string | null = null
  private last: TurnResult | null
  private readonly structured: boolean
  private readonly replay: Run | null
  // answered without starting a task, or an idempotent replay: no events to poll
  private readonly local: boolean

  constructor(
    readonly session: Session,
    private readonly http: Http,
    readonly queued: boolean,
    done: TurnResult | null = null,
    run: { runId: string | null; structured: boolean; replay?: Run } = {
      runId: null,
      structured: false,
    },
  ) {
    this.last = done
    this.runId = run.runId
    this.structured = run.structured
    this.replay = run.replay ?? null
    this.local = done !== null || this.replay !== null
  }

  get status(): TurnStatus {
    return this.last?.status ?? 'running'
  }

  /** The last known state, or null before the first poll. */
  get result(): TurnResult | null {
    return this.last
  }

  /**
   * Yield events until the turn is idle or errors. It keeps going through
   * `needs_approval`: answer with `turn.respond(ev.approval, ...)` inside the
   * loop, or let a human answer a link-only approval in a browser. Without
   * `raw`, framing, reasoning and tool-call frames are skipped.
   */
  async *events(opts: { raw?: boolean; pollWait?: number } = {}): AsyncGenerator<Event> {
    if (this.local) return
    for (;;) {
      const page = await this.#poll(opts.pollWait ?? POLL_WAIT)
      for (const e of page.events ?? []) {
        const ev = parseEvent(e)
        if (opts.raw || ev.kind !== 'other') yield ev
      }
      if (page.status === 'idle' || page.status === 'error') return
    }
  }

  /**
   * Wait until the turn is done, or stops on an approval nobody answered.
   * Without `onApproval`, resolves with `status === 'needs_approval'` and the
   * `approval` so the caller can decide. With it, the handler's answer is sent
   * and waiting continues; a handler returning null leaves the approval to
   * someone else (a link-only one to a human) and keeps waiting. For a
   * structured message, it then waits for the run's result (`result.run`:
   * output, evidence), which is worked out after the turn.
   */
  async wait(opts: WaitOptions = {}): Promise<TurnResult> {
    const deadline = opts.timeoutMs === undefined ? null : Date.now() + opts.timeoutMs
    if (this.replay) {
      const run = this.replay.done
        ? this.replay
        : await waitRun(this.http, this.replay.id, deadline)
      this.last = withRun(localResult(run.sessionId ?? this.session.id ?? '', ''), run)
      return this.last
    }
    if (this.local) return this.last!
    const answered = new Set<string>()
    for (;;) {
      let pollWait = opts.pollWait ?? POLL_WAIT
      if (deadline !== null) {
        const left = deadline - Date.now()
        if (left <= 0) {
          throw new DOMException(
            `Turn still ${this.status} after ${opts.timeoutMs}ms (session ${this.session.id}).`,
            'TimeoutError',
          )
        }
        pollWait = Math.max(1, Math.min(pollWait, Math.floor(left / 1000)))
      }
      const page = await this.#poll(pollWait)
      if (page.status === 'idle' || page.status === 'error') {
        if (this.structured && this.runId) {
          this.last = withRun(this.last!, await waitRun(this.http, this.runId, deadline))
        }
        return this.last!
      }
      const approval = this.last?.approval
      if (page.status !== 'needs_approval' || !approval) continue
      if (!opts.onApproval) return this.last!
      if (answered.has(approval.id)) continue
      const answer = await opts.onApproval(approval)
      answered.add(approval.id)
      if (answer === null) continue
      const [response, selections] = typeof answer === 'string' ? [answer, undefined] : answer
      try {
        await this.session.respond(approval, response, { selections })
      } catch (err) {
        // answered elsewhere or expired; the next poll shows the new state
        if (!(err instanceof ConflictError)) throw err
      }
    }
  }

  respond(
    approval: Approval | string,
    response = 'yes',
    opts: { selections?: string[][] } = {},
  ): Promise<string> {
    return this.session.respond(approval, response, opts)
  }

  abort(): Promise<boolean> {
    return this.session.abort()
  }

  async #poll(wait: number): Promise<EventsPage> {
    let page: EventsPage
    for (;;) {
      try {
        page = await this.http.json<EventsPage>('GET', '/v1/agents/events', {
          params: { sessionId: this.session.id ?? '', wait, since: this.cursor ?? undefined },
          timeoutMs: (wait + 30) * 1000,
        })
        break
      } catch (err) {
        if (!(err instanceof RateLimitError)) throw err
        await new Promise((r) => setTimeout(r, (err.retryAfter ?? 30) * 1000))
      }
    }
    this.cursor = page.cursor ?? this.cursor
    let error = this.last?.error ?? null
    let errorCode = this.last?.errorCode ?? null
    for (const e of page.events ?? []) {
      if (e.type === 'error') {
        error = typeof e.errorText === 'string' ? e.errorText : error
        errorCode = typeof e.code === 'string' ? e.code : errorCode
      }
    }
    const status = page.status ?? 'running'
    this.last = {
      status,
      text: page.text ?? '',
      sessionId: page.sessionId ?? this.session.id ?? '',
      approval: page.approval ? parseApproval(page.approval) : null,
      error,
      errorCode,
      usage: parseUsage(page.usage),
      sessionUsage: parseUsage(page.sessionUsage),
      run: null,
      ok: status === 'idle',
    }
    return page
  }
}

/**
 * Read the run until its status is in `stop`. Throws a `TimeoutError`
 * (DOMException) past `deadline` (epoch ms).
 */
export async function waitRun(
  http: Http,
  runId: string,
  deadline: number | null,
  stop: readonly RunStatus[] = ['succeeded', 'failed'],
): Promise<Run> {
  for (;;) {
    let run: Run
    try {
      run = parseRun(await http.json('GET', `/v1/runs/${encodeURIComponent(runId)}`))
    } catch (err) {
      if (!(err instanceof RateLimitError)) throw err
      await sleep((err.retryAfter ?? 30) * 1000)
      continue
    }
    if (stop.includes(run.status)) return run
    if (deadline !== null && Date.now() + RUN_POLL_INTERVAL_MS > deadline) {
      throw new DOMException(`Run ${runId} still ${run.status}.`, 'TimeoutError')
    }
    await sleep(RUN_POLL_INTERVAL_MS)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function withRun(result: TurnResult, run: Run): TurnResult {
  return { ...result, run, ok: result.status === 'idle' && run.ok }
}

function localResult(sessionId: string, text: string): TurnResult {
  return {
    status: 'idle',
    text,
    sessionId,
    approval: null,
    error: null,
    errorCode: null,
    usage: null,
    sessionUsage: null,
    run: null,
    ok: true,
  }
}
