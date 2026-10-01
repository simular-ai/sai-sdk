import type { SaiApi } from './api.js'
import { ApiError } from './api.js'
import {
  applyEvent,
  decodeCursor,
  encodeCursor,
  initialState,
  markApprovalResolved,
  type SessionState,
} from './reducer.js'
import { parseSse } from './sse.js'
import type {
  ApprovalRequest,
  SessionStatus,
  SseEvent,
  StartRequest,
  StartResult,
  TaskUsage,
  WaitResult,
} from './types.js'

export interface WaitOptions {
  timeoutMs: number
  cursor?: string
  /**
   * Statuses to keep waiting through. `sai_task_wait` uses the default
   * (`running`); the push watcher also waits through `needs_approval` after it
   * has announced the card, until the agent moves again.
   */
  waitWhile?: readonly SessionStatus[]
  /** Return as soon as anything new arrives (the task view's poll), not only on a status change. */
  returnOnEvents?: boolean
}

/**
 * The one seam between the tools and the transport. Two implementations:
 *
 * - `StreamCollector` — TODAY. `POST /message` with the SSE stream; returns as
 *   soon as `data-session` names the session and keeps draining the stream in
 *   this process, folding frames into an in-memory `SessionState`.
 * - `EventsPoller` — LATER (`SAI_EVENTS_API=1`). A1 `wait: false` + A2
 *   `GET /events` long-poll; the server owns the cursor and the status.
 *
 * Flipping the flag is the only change once A1/A2 deploy.
 */
export interface SessionSource {
  start(req: StartRequest): Promise<StartResult>
  wait(sessionId: string, opts: WaitOptions): Promise<WaitResult>
  /** The buffered approval with this id, if this process has seen it. */
  findApproval(approvalId: string): { sessionId: string; approval: ApprovalRequest } | undefined
  /** Local bookkeeping after `POST /approve` succeeded. */
  noteApprovalResolved(approvalId: string): void
}

/** Wakes every waiter on `signal()`; each waiter also has its own deadline. */
class Notifier {
  private waiters = new Set<() => void>()

  signal(): void {
    const current = [...this.waiters]
    this.waiters.clear()
    for (const wake of current) wake()
  }

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          this.waiters.delete(wake)
          resolve()
        },
        Math.max(0, ms),
      )
      timer.unref?.()
      const wake = (): void => {
        clearTimeout(timer)
        resolve()
      }
      this.waiters.add(wake)
    })
  }
}

interface Tracked {
  machineId: string
  state: SessionState
  notifier: Notifier
}

function snapshot(state: SessionState, cursor: string | undefined): WaitResult {
  const from = decodeCursor(cursor, state.events.length)
  return {
    status: state.status,
    events: state.events.slice(from),
    text: state.text,
    ...(state.status === 'needs_approval' && state.approval && { approval: state.approval }),
    cursor: encodeCursor(state.events.length),
    ...(state.status === 'error' && state.error && { error: state.error }),
  }
}

const DEFAULT_WAIT_WHILE: readonly SessionStatus[] = ['running']

/**
 * Whether a wait should keep blocking: the status is one we wait through AND,
 * when parked on an approval, it is still the same approval the caller already
 * knows about (a second card is news even though the status did not change).
 */
function shouldKeepWaiting(
  status: SessionStatus,
  approvalId: string | undefined,
  waitWhile: readonly SessionStatus[],
  knownApprovalId: string | undefined,
): boolean {
  if (!waitWhile.includes(status)) return false
  if (status === 'needs_approval' && approvalId !== knownApprovalId) return false
  return true
}

export const STREAM_CLOSED_ERROR =
  'The connection to Sai closed before the task finished. The task may still be running on the machine; ' +
  'start a new sai_task_start to continue the conversation, or check the Sai app.'

/** TODAY: collect the SSE stream in-process. */
export class StreamCollector implements SessionSource {
  private readonly sessions = new Map<string, Tracked>()

  constructor(
    private readonly api: SaiApi,
    private readonly log: (line: string) => void = () => {},
  ) {}

  async start(req: StartRequest): Promise<StartResult> {
    const res = await this.api.sendMessageStream(req)
    const events = parseSse(res.body!)

    return new Promise<StartResult>((resolve, reject) => {
      let tracked: Tracked | undefined
      let lastStatusText: string | undefined
      const pump = async (): Promise<void> => {
        try {
          for await (const event of events) {
            if (!tracked) {
              // Pre-session frames: `start`, then either `data-session` (a
              // real turn) or the refusal shapes the handler emits when the
              // router handled the message without delivering it.
              if (event.type === 'start') continue
              if (event.type === 'data-session') {
                tracked = this.track(event.data.sessionId, req.machineId)
                resolve({
                  sessionId: event.data.sessionId,
                  machineId: req.machineId,
                  queued: false,
                })
                continue
              }
              if (event.type === 'data-status') {
                lastStatusText = event.data.text
                continue
              }
              if (event.type === 'error') {
                reject(new Error(event.errorText))
                return
              }
              if (event.type === 'finish') {
                reject(
                  new Error(lastStatusText ?? 'Sai handled the message without starting a task.'),
                )
                return
              }
              continue
            }
            if (event.type === 'start' || event.type === 'data-session') continue
            this.push(tracked, event)
          }
          if (!tracked) {
            reject(new Error('The task stream closed before Sai reported a session id.'))
          } else if (
            tracked.state.status === 'running' ||
            tracked.state.status === 'needs_approval'
          ) {
            this.push(tracked, { type: 'error', errorText: STREAM_CLOSED_ERROR })
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (!tracked) reject(new Error(`The task stream failed: ${message}`))
          else
            this.push(tracked, { type: 'error', errorText: `${STREAM_CLOSED_ERROR} (${message})` })
        }
      }
      void pump()
    })
  }

  private track(sessionId: string, machineId: string): Tracked {
    // A new turn on a session this process already knows replaces the old
    // state: `text` and `events` are per turn (§4), and an older stream still
    // draining writes into the object it holds, not this one.
    const tracked: Tracked = { machineId, state: initialState(), notifier: new Notifier() }
    this.sessions.set(sessionId, tracked)
    this.log(`session ${sessionId}: tracking turn on machine ${machineId}`)
    return tracked
  }

  private push(tracked: Tracked, event: SseEvent): void {
    applyEvent(tracked.state, event)
    tracked.notifier.signal()
  }

  async wait(sessionId: string, opts: WaitOptions): Promise<WaitResult> {
    const tracked = this.sessions.get(sessionId)
    if (!tracked) {
      throw new Error(
        `Unknown session ${sessionId}: only sessions started by sai_task_start in this MCP server ` +
          'process can be waited on. Call sai_task_start again to continue the conversation.',
      )
    }
    const waitWhile = opts.waitWhile ?? DEFAULT_WAIT_WHILE
    const knownApprovalId = tracked.state.approval?.approvalId
    const deadline = Date.now() + opts.timeoutMs
    while (
      shouldKeepWaiting(
        tracked.state.status,
        tracked.state.approval?.approvalId,
        waitWhile,
        knownApprovalId,
      )
    ) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await tracked.notifier.wait(remaining)
      if (opts.returnOnEvents) break
    }
    return snapshot(tracked.state, opts.cursor)
  }

  findApproval(approvalId: string): { sessionId: string; approval: ApprovalRequest } | undefined {
    for (const [sessionId, tracked] of this.sessions) {
      const approval = tracked.state.approval
      if (approval?.approvalId === approvalId) return { sessionId, approval }
    }
    return undefined
  }

  noteApprovalResolved(approvalId: string): void {
    for (const tracked of this.sessions.values()) {
      markApprovalResolved(tracked.state, approvalId)
      tracked.notifier.signal()
    }
  }
}

/** Max `wait` the server accepts on `/events` (§4). */
export const EVENTS_MAX_WAIT_S = 60
/** Re-poll interval while parked on an approval (the server does not long-poll there). */
export const APPROVAL_REPOLL_MS = 5_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })
}

interface Polled {
  machineId?: string
  /** Local fold of what we have seen, so `approval` survives across polls. */
  state: SessionState
}

/** LATER: A1 + A2. The server owns cursor, status and text; we keep the approval card. */
export class EventsPoller implements SessionSource {
  private readonly sessions = new Map<string, Polled>()

  constructor(private readonly api: SaiApi) {}

  async start(req: StartRequest): Promise<StartResult> {
    const result = await this.api.sendMessageNoWait(req)
    this.sessions.set(result.sessionId, { machineId: result.machineId, state: initialState() })
    return result
  }

  /**
   * `/events` sits behind a gateway that can answer 502/503/504 for a moment
   * (a cold replica, a long-poll cut at the edge — seen once on staging). Those
   * are not the caller's fault and not the task's state, so retry a few times
   * before surfacing them; every other status goes straight to the caller.
   */
  private async eventsWithRetry(
    sessionId: string,
    since: string | undefined,
    waitS: number,
  ): Promise<Awaited<ReturnType<SaiApi['events']>>> {
    const RETRIES = 3
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.api.events(sessionId, since, waitS)
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 0
        if (attempt >= RETRIES || (status !== 502 && status !== 503 && status !== 504)) throw err
        await sleep(1000 * (attempt + 1))
      }
    }
  }

  async wait(sessionId: string, opts: WaitOptions): Promise<WaitResult> {
    // A session this process did not start is still pollable: the server checks ownership.
    const polled =
      this.sessions.get(sessionId) ??
      this.sessions.set(sessionId, { state: initialState() }).get(sessionId)!
    const waitWhile = opts.waitWhile ?? DEFAULT_WAIT_WHILE
    const knownApprovalId = polled.state.approval?.approvalId
    const deadline = Date.now() + opts.timeoutMs
    const collected: SseEvent[] = []
    let since = opts.cursor
    let status: SessionStatus = 'running'
    let text = ''
    let usage: TaskUsage | undefined
    let sessionUsage: TaskUsage | undefined
    // The view's poll already has a cursor: hold straight away, one request per poll.
    let first = !(opts.returnOnEvents && opts.cursor)
    for (;;) {
      const remainingS = Math.ceil((deadline - Date.now()) / 1000)
      // First poll returns immediately (wait=0) so a task that already ended
      // costs no hold time; later polls hold for what is left, capped at 60.
      const waitS = first ? 0 : Math.max(0, Math.min(EVENTS_MAX_WAIT_S, remainingS))
      first = false
      const page = await this.eventsWithRetry(sessionId, since, waitS)
      for (const event of page.events) {
        collected.push(event)
        applyEvent(polled.state, event)
      }
      since = page.cursor
      status = page.status
      text = page.text
      usage = page.usage ?? usage
      sessionUsage = page.sessionUsage ?? sessionUsage
      // The server's own view of the pending card outranks the local fold.
      if (page.approval) {
        polled.state.approval = page.approval
        polled.state.status = 'needs_approval'
      }
      if (
        !shouldKeepWaiting(status, polled.state.approval?.approvalId, waitWhile, knownApprovalId) ||
        Date.now() >= deadline ||
        (opts.returnOnEvents && collected.length > 0)
      ) {
        break
      }
      // `/events` only holds `wait=` while the turn is running; parked on an
      // approval it answers at once, and the endpoint is rate-limited
      // (1200/h per account). Pace ourselves instead of spinning.
      if (status !== 'running') {
        await sleep(Math.min(APPROVAL_REPOLL_MS, Math.max(0, deadline - Date.now())))
      }
    }
    const errorEvent = [...collected].reverse().find((e) => e.type === 'error')
    return {
      status,
      events: collected,
      text,
      ...(usage && { usage }),
      ...(sessionUsage && { sessionUsage }),
      ...(status === 'needs_approval' &&
        polled.state.approval && { approval: polled.state.approval }),
      cursor: since ?? '',
      ...(status === 'error' && {
        error:
          errorEvent && errorEvent.type === 'error' ? errorEvent.errorText : polled.state.error,
      }),
    }
  }

  findApproval(approvalId: string): { sessionId: string; approval: ApprovalRequest } | undefined {
    for (const [sessionId, polled] of this.sessions) {
      const approval = polled.state.approval
      if (approval?.approvalId === approvalId) return { sessionId, approval }
    }
    return undefined
  }

  noteApprovalResolved(approvalId: string): void {
    for (const polled of this.sessions.values()) markApprovalResolved(polled.state, approvalId)
  }
}
