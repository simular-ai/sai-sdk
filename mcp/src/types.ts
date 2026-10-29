/**
 * Wire shapes shared by both transport adapters.
 *
 * `SseEvent` is the AI SDK v6 UI message stream vocabulary that
 * `POST /v1/agents/message` streams today and that `GET /v1/agents/events`
 * (A2) returns as JSON arrays, minus `start` / `[DONE]`. Kept in sync with
 * `cloud-api/src/routes/cli.ts` and `packages/sai-cli/src/sai/client.ts`; the
 * contract is docs/plans/2026-09-29-sai-api-mvp.md §3–§5.
 */

export interface ChoiceQuestion {
  message: string
  options: Array<{ value: string; label: string }>
  multiple: boolean
  allowOther: boolean
}

/** `data-approval-request.data` — today's fields plus `approvalUrl` (link-only events only) / `expiresAt`. */
export interface ApprovalRequest {
  approvalId: string
  title: string
  description: string
  approvalType: string
  /** true for service_connect | user_input | phone_verification — only a human in a browser can finish it. */
  isLinkOnly: boolean
  /** A3: always present once it ships; built client-side until then. */
  approvalUrl?: string
  command?: string
  cwd?: string
  questions?: ChoiceQuestion[]
  options?: Array<{ value: string; label: string }>
  multiple?: boolean
  allowOther?: boolean
  expiresAt?: number
}

export type SseEvent =
  | { type: 'start'; messageId?: string }
  | { type: 'data-session'; data: { sessionId: string } }
  /** The turn this message started; sent right after `data-session`. */
  | { type: 'data-turn'; data: { turnId: string } }
  | { type: 'data-status'; data: { text: string; sessionId?: string; kind?: string } }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'reasoning-start'; id: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'reasoning-end'; id: string }
  | {
      type: 'tool-input-start'
      toolCallId: string
      toolName: string
      toolMetadata?: Record<string, unknown>
    }
  | { type: 'tool-input-available'; toolCallId: string; toolName: string; input: unknown }
  | {
      type: 'tool-output-error'
      toolCallId: string
      errorText: string
      /** `insufficient_credits` / `free_computer_time_exhausted`, on servers that send it. */
      code?: string
      /** ISO time the free daily credits refresh (`insufficient_credits`). */
      resetsAt?: string
    }
  | { type: 'data-progress'; data: { text: string; tool: string } }
  | { type: 'data-approval-request'; data: ApprovalRequest }
  | { type: 'finish'; finishReason?: string }
  | {
      type: 'error'
      errorText: string
      /** Machine-readable reason (`insufficient_credits`, `agent_error`, …), on servers that send it. */
      code?: string
      resetsAt?: string
    }

export type SessionStatus = 'running' | 'needs_approval' | 'idle' | 'error'

/** What `sai_task_wait` returns — the §4 poll response shape, snake_cased for the tool. */
/** `GET /events` `usage`: this task's model tokens and cost so far. */
export interface TaskUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  modelCalls: number
  byModel: Record<string, Omit<TaskUsage, 'byModel'>>
}

export interface WaitResult {
  status: SessionStatus
  events: SseEvent[]
  text: string
  approval?: ApprovalRequest
  /** This task's token usage so far, when the API reports it. */
  usage?: TaskUsage
  /** The session's token usage so far, across its tasks. */
  sessionUsage?: TaskUsage
  cursor: string
  /** Set on `status: 'error'` — the `error` frame's text. */
  error?: string
  /** Set on `status: 'error'` when the `error` frame carried a `code`. */
  errorCode?: string
}

export interface StartRequest {
  machineId: string
  message: string
  attachments?: UploadedFile[]
  /** Model id from GET /models, or `auto`. Sticks to the session. */
  model?: string
  /** Run the turn this message starts without approval cards; the grant ends with the turn. */
  autonomous?: boolean
  /** Record the turn's steps, so `POST /learn` can turn it into code. */
  recordTrajectory?: boolean
}

export interface StartResult {
  sessionId: string
  machineId: string
  queued: boolean
  /** The turn this message started, on servers that send it. */
  turnId?: string
}

/** `POST /v1/agents/upload` response; also the attachment shape `/message` takes. */
export interface UploadedFile {
  path: string
  name: string
  mime: string
  size: number
  fileId: string
}

export interface MachineRow {
  machineId: string
  name?: string
  updatedAt?: number
  /** `running` / `starting` / `asleep` / `creating` / `unknown`, on servers that send it. */
  state?: string
  /** Deprecated by the server in favour of `state`: the internal lifecycle value. */
  status?: string
  canWake?: boolean
  /** A4 fields — present once cloud-api ships them. */
  kind?: 'cloud' | 'own'
  online?: boolean
}

/** `POST /v1/agents/machines/:id/live` response. */
export interface LiveScreen {
  machineId?: string
  /** Guacamole tunnel with a session token; it takes input. Never to the model or a log. */
  websocketUrl: string
  width: number
  height: number
  /** A hosted page a person opens without a Simular sign-in; absent where the server doesn't offer it. */
  liveUrl?: string
  /** When `liveUrl` stops working, epoch ms. */
  expiresAt?: number
}

/** An OSWorld attempt as cloud-api returns it (routes/osworld-attempts.ts). */
export interface OsworldAttempt {
  attemptId: string
  taskId: string
  state: 'starting' | 'ready' | 'evaluating' | 'scored' | 'abandoned' | 'failed'
  machineId: string | null
  instruction: string | null
  hasUser: boolean
  score: number | null
  /** Why a `failed` or `abandoned` attempt ended (`setup_failed`, `expired`, …); null otherwise. */
  reason?: string | null
}
