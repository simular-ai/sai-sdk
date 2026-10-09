/**
 * Sessions: a conversation with Sai on one computer. Sai decides every click.
 *
 * Maps to `/v1/agents/*`: `new-session`, `message` (wait=false), `events`,
 * `approve`, `abort`.
 */

import { ConflictError, LinkOnlyApprovalError, NotFoundError, RateLimitError } from './errors.js'
import type { Http } from './http.js'
import { idOf, type MachineRef, type Machines } from './machines.js'
import {
  parseApproval,
  parseEvent,
  parseUsage,
  type Approval,
  type Attachment,
  type Event,
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
}

export interface WaitOptions {
  onApproval?: ApprovalHandler
  /** Throws a `TimeoutError` (DOMException) with the turn still running. */
  timeoutMs?: number
  /** Seconds the server may hold one poll; it caps at 60. */
  pollWait?: number
}

const POLL_WAIT = 30

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
   */
  async send(message: string, opts: SendOptions = {}): Promise<Turn> {
    const body: Record<string, unknown> = { message, wait: false }
    if (this.machineId) body.machineId = this.machineId
    if (opts.model) body.model = opts.model
    if (opts.attachments?.length) body.attachments = opts.attachments.map((a) => a.raw)
    const d = await this.http.json<Record<string, unknown>>('POST', '/v1/agents/message', {
      json: body,
    })
    if (typeof d.sessionId !== 'string' || !d.sessionId) {
      // Handled without starting a task (e.g. a plain acknowledgement): the reply is in `error`.
      const text = typeof d.error === 'string' ? d.error : ''
      return new Turn(this, this.http, false, localResult(this.id ?? '', text))
    }
    this.id = d.sessionId
    if (typeof d.machineId === 'string') this.machineId = d.machineId
    return new Turn(this, this.http, Boolean(d.queued))
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

/** One message's work. Iterate `events()` to watch it, or `wait()` for the result. */
export class Turn {
  private cursor: string | null = null
  private last: TurnResult | null
  // answered without starting a task: nothing to poll
  private readonly local: boolean

  constructor(
    readonly session: Session,
    private readonly http: Http,
    readonly queued: boolean,
    done: TurnResult | null = null,
  ) {
    this.last = done
    this.local = done !== null
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
   * someone else (a link-only one to a human) and keeps waiting.
   */
  async wait(opts: WaitOptions = {}): Promise<TurnResult> {
    if (this.local) return this.last!
    const deadline = opts.timeoutMs === undefined ? null : Date.now() + opts.timeoutMs
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
      if (page.status === 'idle' || page.status === 'error') return this.last!
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
      ok: status === 'idle',
    }
    return page
  }
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
    ok: true,
  }
}
