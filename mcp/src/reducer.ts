import type { ApprovalRequest, SessionStatus, SseEvent } from './types.js'

/**
 * Per-turn session state, derived purely from the event stream so both
 * adapters (SSE collector today, `/events` poller later) share one notion of
 * "where is this task". Mirrors §4's `status` / `text` semantics:
 *
 * - `data-approval-request` → `needs_approval` (latest approval kept)
 * - `finish`                → `idle`
 * - `error`                 → `error`
 * - any other activity      → `running` (an approval that was answered shows
 *                             up as the agent resuming: text, tools, progress)
 */
export interface SessionState {
  status: SessionStatus
  /** Every event of the current turn, in arrival order; `cursor` indexes into it. */
  events: SseEvent[]
  /** Assistant text of the current turn so far (`text-delta` concatenated). */
  text: string
  approval?: ApprovalRequest
  error?: string
}

export function initialState(): SessionState {
  return { status: 'running', events: [], text: '' }
}

/** Frames that mean "the agent is doing something", i.e. it is no longer parked on an approval. */
const ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  'text-start',
  'text-delta',
  'text-end',
  'reasoning-start',
  'reasoning-delta',
  'reasoning-end',
  'tool-input-start',
  'tool-input-available',
  'tool-output-error',
  'data-progress',
])

/** Applies one event in place and returns the same state object. */
export function applyEvent(state: SessionState, event: SseEvent): SessionState {
  state.events.push(event)
  switch (event.type) {
    case 'text-delta':
      state.text += event.delta
      state.status = 'running'
      state.approval = undefined
      break
    case 'data-approval-request':
      state.status = 'needs_approval'
      state.approval = event.data
      break
    case 'finish':
      state.status = 'idle'
      state.approval = undefined
      break
    case 'error':
      state.status = 'error'
      state.error = event.errorText
      state.approval = undefined
      break
    default:
      if (ACTIVITY_TYPES.has(event.type)) {
        state.status = 'running'
        state.approval = undefined
      }
  }
  return state
}

/**
 * Cursor codec for the in-memory collector: the number of events already
 * handed out. Opaque to callers, like the server's (§4). A cursor from another
 * adapter or a garbage string reads as "from the start".
 */
export function decodeCursor(cursor: string | undefined, max: number): number {
  if (!cursor) return 0
  const n = Number.parseInt(cursor, 10)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(n, max)
}

export function encodeCursor(index: number): string {
  return String(index)
}

/**
 * The local view of "this approval was just answered": flip back to running so
 * an immediate `sai_task_wait` blocks for the agent's next move instead of
 * re-reporting the card the caller just resolved.
 */
export function markApprovalResolved(state: SessionState, approvalId: string): void {
  if (state.status === 'needs_approval' && state.approval?.approvalId === approvalId) {
    state.status = 'running'
    state.approval = undefined
  }
}
