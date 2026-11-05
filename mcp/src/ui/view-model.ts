/**
 * What the task view shows, derived from `sai_view_poll` results. Pure (no
 * DOM), so it runs in the iframe and in vitest alike.
 */
import type { ApprovalRequest, SessionStatus, SseEvent } from '../types.js'

export interface TaskView {
  sessionId: string | null
  status: SessionStatus | 'starting'
  /** One entry per thing Sai did, oldest first. */
  steps: Step[]
  /** The assistant's text so far (the answer once `idle`). */
  text: string
  approval?: ApprovalRequest
  error?: string
  playgroundUrl?: string
}

/**
 * A step: what Sai set out to do (a tool call's `title`, or a progress line
 * on its own), and the latest thing it reported while doing it.
 */
export interface Step {
  title: string
  detail?: string
  /** The tool call it belongs to, so later progress attaches to it. */
  callId?: string
}

export const initialView: TaskView = { sessionId: null, status: 'starting', steps: [], text: '' }

const MAX_STEPS = 200

/** A tool name as a person would say it: `browser_navigate` → "Browser navigate". */
export function humanTool(name: string): string {
  const s = name
    .replace(/^mcp__[^_]+__/, '')
    .replace(/[_-]+/g, ' ')
    .trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : name
}

/** Sai's own diagnostics (`[Guardrails] …`), not something it is doing. */
const INTERNAL_NOTE = /^\[[A-Za-z ]+\]/
const MAX_STEP_CHARS = 160

/** A progress line that is really a raw tool result (`{"stdout":…}`, `[]`). */
function isRawOutput(text: string): boolean {
  if (!/^[[{]/.test(text)) return false
  try {
    return typeof JSON.parse(text) === 'object'
  } catch {
    // Cut off mid-JSON by the agent's own truncation.
    return /^(\[\s*[{"\]]|\{\s*")/.test(text)
  }
}

function stepText(text: string): string | null {
  const t = text.trim()
  if (!t || INTERNAL_NOTE.test(t) || isRawOutput(t)) return null
  return t.length > MAX_STEP_CHARS ? `${t.slice(0, MAX_STEP_CHARS - 1)}…` : t
}

function inputTitle(input: unknown): string | undefined {
  const t = (input as { title?: unknown } | null)?.title
  return typeof t === 'string' && t.trim() ? t.trim() : undefined
}

/**
 * Folds events into steps. Each tool call is a step titled by its `title`
 * input (Sai's own one-line intent), or the tool's name for tools without one;
 * the `execute` code tool has no name worth showing. Progress lines become the
 * step's detail. `/events` can drop a call's first progress line (the title
 * echo), so the title comes from the call, not from progress.
 *
 * Left out: recovered errors (a failed turn still shows `view.error`),
 * diagnostics, raw tool output, and repeats.
 */
function foldSteps(prev: Step[], events: SseEvent[]): Step[] {
  const steps = [...prev]
  const last = (): Step | undefined => steps.at(-1)
  const byCall = (id: string): Step | undefined => steps.find((s) => s.callId === id)
  for (const e of events) {
    if (e.type === 'tool-input-start') {
      if (e.toolName !== 'execute' && !byCall(e.toolCallId))
        steps.push({ title: humanTool(e.toolName), callId: e.toolCallId })
    } else if (e.type === 'tool-input-available') {
      const title =
        inputTitle(e.input) ?? (e.toolName === 'execute' ? undefined : humanTool(e.toolName))
      if (!title) continue
      const existing = byCall(e.toolCallId)
      if (existing) existing.title = title
      else steps.push({ title, callId: e.toolCallId })
    } else if ((e.type === 'data-progress' || e.type === 'data-status') && e.data?.text) {
      const text = stepText(e.data.text)
      const cur = last()
      if (!text || text === cur?.title || text === cur?.detail) continue
      if (cur?.callId) steps[steps.length - 1] = { ...cur, detail: text }
      else steps.push({ title: text })
    }
  }
  return steps
}

/** The answer's inline Markdown (bold, code), on escaped text: no HTML from the model gets through. */
export function inlineMarkdown(text: string): string {
  const esc = (t: string): string =>
    t.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    )
  // Code spans first, so a `*` inside one can't end a bold run.
  const codes: string[] = []
  // U+E000 (private use) marks a held span; any in the input is dropped first.
  const held = text.replace(/\uE000/g, '').replace(/`([^`\n]+)`/g, (_, code: string) => {
    codes.push(`<code>${esc(code)}</code>`)
    return `\uE000${codes.length - 1}\uE000`
  })
  return esc(held)
    .replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\uE000(\d+)\uE000/g, (_, i: string) => codes[Number(i)]!)
}

export interface PollResult {
  status: SessionStatus
  events?: SseEvent[]
  text?: string
  approval?: ApprovalRequest
  error?: string
  cursor?: string
  playground_url?: string
}

/** Folds one poll into the view. `events` are only the new ones since the last cursor. */
export function applyPoll(view: TaskView, poll: PollResult): TaskView {
  const steps = foldSteps(view.steps, poll.events ?? [])
  return {
    ...view,
    status: poll.status,
    steps: steps.slice(-MAX_STEPS),
    text: poll.text ?? view.text,
    approval: poll.status === 'needs_approval' ? poll.approval : undefined,
    error: poll.error,
    playgroundUrl: poll.playground_url ?? view.playgroundUrl,
  }
}

export function isDone(view: TaskView): boolean {
  return view.status === 'idle' || view.status === 'error'
}

/**
 * Whether the person's mouse and keyboard reach the computer: only while Sai
 * isn't working on it. That is while the task waits on their approval, or
 * after the task ended while they use the computer (until they press Done).
 */
export function inputAllowed(view: TaskView, using: boolean): boolean {
  return view.status === 'needs_approval' || (isDone(view) && using)
}

/** A `sai_view_poll` result, as the view reads it. */
export type ViewPoll = Partial<PollResult> & { archived?: boolean; expired?: boolean }

export const ANOTHER_TASK_NOTE =
  'Sai started another task on this computer, so it has the mouse and keyboard again.'
export const UNKNOWN_TASK_NOTE =
  "Sai was restarted, so this view can't tell whether the computer is free. Send Sai a task instead."

/**
 * While the person uses the computer after the task, the view keeps polling.
 * Why to stop (`undefined`: keep going): a newer task started on this computer
 * (`archived`), the session started a new turn (its status is no longer done),
 * or the server no longer knows this task (`expired`) and can't tell.
 */
export function useEnd(poll: ViewPoll): string | undefined {
  if (poll.archived) return ANOTHER_TASK_NOTE
  if (poll.expired) return UNKNOWN_TASK_NOTE
  if (poll.status !== 'idle' && poll.status !== 'error') return ANOTHER_TASK_NOTE
  return undefined
}

/**
 * After the task, the live screen has no tunnel (`no_tunnel`) or its stream
 * became unreachable: the computer is asleep or taken back. Using it stops
 * then, instead of waiting for it; while the task runs, the view waits.
 */
export function useStopsOnLoss(view: TaskView, loss: 'no_tunnel' | string): boolean {
  return isDone(view) && (loss === 'no_tunnel' || loss === 'unreachable')
}

/** The headline: what Sai is doing right now, in one line. */
export function headline(view: TaskView): string {
  if (view.status === 'starting') return 'Starting Sai…'
  if (view.status === 'needs_approval') return 'Sai needs your OK to continue'
  if (view.status === 'error') return 'Sai stopped with an error'
  if (view.status === 'idle') return 'Done'
  return view.steps.at(-1)?.title ?? 'Sai is working…'
}
