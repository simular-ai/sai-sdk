/**
 * Response objects. Each keeps the server's JSON in `raw`, so a field the SDK
 * does not model yet is still reachable.
 */

type Json = Record<string, unknown>

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown, d = 0): number => (typeof v === 'number' ? v : d)
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})

export interface Account {
  userId: string
  planId: string | null
  planTitle: string
  free: boolean
  unlimited: boolean
  /** Spendable credit in USD; null on the unlimited plan or when billing could not be reached. */
  creditsUsd: number | null
  raw: Json
}

export function parseAccount(d: Json): Account {
  const plan = obj(d.plan)
  const credits = obj(d.credits)
  return {
    userId: str(d.userId) ?? '',
    planId: str(plan.id) ?? null,
    planTitle: str(plan.title) ?? '',
    free: Boolean(plan.free),
    unlimited: Boolean(plan.unlimited),
    creditsUsd: typeof credits.usd === 'number' ? credits.usd : null,
    raw: d,
  }
}

export interface Model {
  id: string
  name: string
  provider: string
  tier: string
  costTier: string
  allowed: boolean
  raw: Json
}

export function parseModel(d: Json): Model {
  const id = str(d.id) ?? ''
  return {
    id,
    name: str(d.name) ?? id,
    provider: str(d.provider) ?? '',
    tier: str(d.tier) ?? '',
    costTier: str(d.costTier) ?? '',
    allowed: d.allowed === undefined ? true : Boolean(d.allowed),
    raw: d,
  }
}

export interface Machine {
  id: string
  name: string | null
  /** `cloud` (hosted by Simular) or `own` (a desktop with the Sai app). */
  kind: string
  /** True when a message can reach it now (a hibernated cloud computer wakes on the first message). */
  online: boolean
  status: string | null
  canWake: boolean
  raw: Json
}

export function parseMachine(d: Json): Machine {
  return {
    id: str(d.machineId) ?? '',
    name: str(d.name) ?? null,
    kind: str(d.kind) ?? '',
    online: Boolean(d.online),
    status: str(d.status) ?? null,
    canWake: Boolean(d.canWake),
    raw: d,
  }
}

/** A file uploaded with `sai.files.upload()`. Pass it in `attachments`. */
export interface Attachment {
  fileId: string
  name: string
  mime: string
  size: number
  raw: Json
}

export function parseAttachment(d: Json): Attachment {
  return {
    fileId: str(d.fileId) ?? '',
    name: str(d.name) ?? '',
    mime: str(d.mime) ?? '',
    size: num(d.size),
    raw: d,
  }
}

/** A view-only Guacamole stream of a computer's screen. The URL carries a token: keep it private. */
export interface LiveView {
  machineId: string
  websocketUrl: string
  width: number
  height: number
}

/** Sai is waiting for permission (or for an answer to a choice question). */
export interface Approval {
  id: string
  title: string
  description: string
  /** `exec`, `choice`, ...; a `choice` needs `selections` when approved. */
  type: string
  /** True: a human must answer in a browser at `url`; the API cannot. */
  isLinkOnly: boolean
  url: string | null
  command: string | null
  questions: Json[]
  raw: Json
}

export function parseApproval(d: Json): Approval {
  return {
    id: str(d.approvalId) ?? '',
    title: str(d.title) ?? '',
    description: str(d.description) ?? '',
    type: str(d.approvalType) ?? '',
    isLinkOnly: Boolean(d.isLinkOnly),
    url: str(d.approvalUrl) ?? null,
    command: str(d.command) ?? null,
    questions: Array.isArray(d.questions) ? (d.questions as Json[]) : [],
    raw: d,
  }
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  modelCalls: number
  byModel: Json
}

export function parseUsage(d: unknown): Usage | null {
  if (!d || typeof d !== 'object') return null
  const u = d as Json
  return {
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    cacheReadTokens: num(u.cacheReadTokens),
    cacheWriteTokens: num(u.cacheWriteTokens),
    costUsd: num(u.costUsd),
    modelCalls: num(u.modelCalls),
    byModel: obj(u.byModel),
  }
}

/** The SDK's event kinds. `other` only appears with `events({ raw: true })`. */
export const EVENT_KINDS = [
  'step',
  'message',
  'approval',
  'tool_error',
  'error',
  'finished',
  'other',
] as const
export type EventKind = (typeof EVENT_KINDS)[number]

// Wire event type → SDK kind. Anything not listed is framing or internal detail,
// and is yielded only with `events({ raw: true })`.
const KINDS: Record<string, EventKind> = {
  'data-progress': 'step',
  'text-delta': 'message',
  'data-approval-request': 'approval',
  'tool-output-error': 'tool_error',
  error: 'error',
  finish: 'finished',
}

/**
 * One thing that happened in a turn. `kind` is the SDK's name; `type` is the
 * wire type.
 */
export interface Event {
  kind: EventKind
  type: string
  text: string | null
  approval: Approval | null
  /** `insufficient_credits` / `free_computer_time_exhausted` on errors: stop retrying today. */
  code: string | null
  raw: Json
}

export function parseEvent(d: Json): Event {
  const t = str(d.type) ?? ''
  const data = obj(d.data)
  let text: string | null = null
  let approval: Approval | null = null
  if (t === 'data-progress') text = str(data.text) ?? null
  else if (t === 'text-delta' || t === 'reasoning-delta') text = str(d.delta) ?? null
  else if (t === 'tool-output-error' || t === 'error') text = str(d.errorText) ?? null
  else if (t === 'data-approval-request' && data.approvalId) {
    approval = parseApproval(data)
    text = approval.title
  }
  return { kind: KINDS[t] ?? 'other', type: t, text, approval, code: str(d.code) ?? null, raw: d }
}

/** Turn statuses: `running` while polling, then one of the three below. */
export const TURN_STATUSES = ['running', 'idle', 'needs_approval', 'error'] as const
export type TurnStatus = (typeof TURN_STATUSES)[number]

/**
 * Where a turn stopped. `status` is `idle` (done: `text` is the answer),
 * `error`, or `needs_approval` (waiting on `approval`; answer it and call
 * `wait()` again).
 */
export interface TurnResult {
  status: TurnStatus
  text: string
  sessionId: string
  approval: Approval | null
  error: string | null
  errorCode: string | null
  usage: Usage | null
  sessionUsage: Usage | null
  ok: boolean
}

export interface ExecError {
  /** `exception`, `timeout` or `interrupted`. */
  kind: string
  message: string
  stack: string | null
}

/** What one Simulang block returned. A block that threw is still a result: check `error`. */
export interface ExecResult {
  result: unknown
  logs: string[]
  error: ExecError | null
  /** The screenshot the block captured (page/app snapshot, pageContent), decoded. */
  screenshotPng: Uint8Array | null
  screenshotOmitted: boolean
  variables: Json[]
  durationMs: number
  ok: boolean
  raw: Json
}

export function parseExecResult(d: Json): ExecResult {
  const obs = obj(d.observations)
  const shot = obj(obs.screenshot)
  const err = d.error ? obj(d.error) : null
  const b64 = str(shot.base64)
  const error = err
    ? { kind: str(err.kind) ?? '', message: str(err.message) ?? '', stack: str(err.stack) ?? null }
    : null
  return {
    result: d.result ?? null,
    logs: Array.isArray(d.logs) ? (d.logs as string[]) : [],
    error,
    screenshotPng: b64 ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) : null,
    screenshotOmitted: Boolean(obs.screenshotOmitted),
    variables: Array.isArray(d.variables) ? (d.variables as Json[]) : [],
    durationMs: num(d.durationMs),
    ok: error === null,
    raw: d,
  }
}
