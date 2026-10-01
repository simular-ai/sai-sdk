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

/** `data-approval-request.data` — today's fields plus A3's `approvalUrl` / `expiresAt`. */
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
  | { type: 'tool-output-error'; toolCallId: string; errorText: string }
  | { type: 'data-progress'; data: { text: string; tool: string } }
  | { type: 'data-approval-request'; data: ApprovalRequest }
  | { type: 'finish'; finishReason?: string }
  | { type: 'error'; errorText: string }

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
  cursor: string
  /** Set on `status: 'error'` — the `error` frame's text. */
  error?: string
}

export interface StartRequest {
  machineId: string
  message: string
  attachments?: UploadedFile[]
  /** Model id from GET /models, or `auto`. Sticks to the session. */
  model?: string
}

export interface StartResult {
  sessionId: string
  machineId: string
  queued: boolean
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
  status?: string
  canWake?: boolean
  /** A4 fields — present once cloud-api ships them. */
  kind?: 'cloud' | 'own'
  online?: boolean
}
