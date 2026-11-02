import type {
  ApprovalRequest,
  LiveScreen,
  MachineRow,
  OsworldAttempt,
  SseEvent,
  StartRequest,
  StartResult,
  TaskUsage,
  UploadedFile,
} from './types.js'
import { SERVER_VERSION } from './version.js'

/**
 * A non-2xx cloud-api response. `body` is the JSON the server sent: `{ error: "<code>",
 * message: "<text>" }` on current servers, `{ error: "<text>" }` on older ones.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** `GET /v1/agents/events` response (§4). */
export interface EventsResponse {
  sessionId?: string
  events: SseEvent[]
  cursor: string
  status: 'running' | 'needs_approval' | 'idle' | 'error'
  text: string
  /** The first pending approval's event data (carries approvalUrl, isLinkOnly). */
  approval?: ApprovalRequest
  /** This task's token usage so far; absent before the first billed model call. */
  usage?: TaskUsage
  /** The session's token usage so far, across its tasks. */
  sessionUsage?: TaskUsage
}

export type ApproveResponse = 'yes' | 'no' | 'task'

/** What `POST /v1/machines/:id/control/exec` returns (cloud-api routes/machine-control.ts). */
export interface ExecResult {
  result?: unknown
  logs: string[]
  error?: { kind: string; message: string; stack?: string }
  observations: { screenshot?: { base64: string; mimeType: string } }
  variables: Array<{ name: string; type: string; preview: string }>
  durationMs: number
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Node's fetch rejects connection failures with an opaque `TypeError: fetch
 * failed` and hides the reason on `.cause`; name the host and the cause so the
 * model (and the human reading the transcript) can tell DNS from a bad key.
 */
function toNetworkError(url: string, err: unknown): Error {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new Error(`Request to ${hostOf(url)} timed out.`)
  }
  const cause =
    err instanceof Error
      ? (err.cause as { code?: string; message?: string } | undefined)
      : undefined
  const detail = cause?.message ?? cause?.code ?? (err instanceof Error ? err.message : String(err))
  return new Error(
    `Could not reach the Sai API at ${hostOf(url)}: ${detail}. Check the network and SAI_API_URL.`,
  )
}

async function readError(res: Response, prefix: string): Promise<ApiError> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  // `message` is the human text on current servers; older ones put it in `error`.
  const detail =
    typeof body.message === 'string' && body.message
      ? body.message
      : typeof body.error === 'string' && body.error
        ? body.error
        : res.statusText
  const hint =
    res.status === 401
      ? ' SAI_API_KEY was rejected — it may be revoked or expired (Firebase ID tokens last one hour).'
      : ''
  return new ApiError(res.status, body, `${prefix} (${res.status}): ${detail}${hint}`)
}

/**
 * Thin typed client over `/v1/agents/*`. Every method throws `ApiError` on a
 * non-2xx status, so callers decide which statuses are outcomes (409 link_only)
 * and which are failures. `fetchImpl` is injectable for tests.
 */
export class SaiApi {
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly versionTag?: string,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      // identifies this client to cloud-api, which records it per API key
      'User-Agent': `sai-mcp/${SERVER_VERSION}`,
      ...(this.versionTag && { 'x-sai-version': this.versionTag }),
      ...extra,
    }
  }

  private async request(path: string, init: RequestInit & { prefix: string }): Promise<Response> {
    const url = `${this.apiUrl}${path}`
    const { prefix, ...rest } = init
    let res: Response
    try {
      res = await this.fetchImpl(url, rest)
    } catch (err) {
      throw toNetworkError(url, err)
    }
    if (!res.ok) throw await readError(res, prefix)
    return res
  }

  private async json<T>(path: string, init: RequestInit & { prefix: string }): Promise<T> {
    const res = await this.request(path, init)
    return (await res.json()) as T
  }

  // ─── Direct control (Layer 2: /v1/machines/:id/control) ─────────────────────

  private controlPath(machineId: string): string {
    return `/v1/machines/${encodeURIComponent(machineId)}/control`
  }

  /**
   * `POST /v1/machines/:id/control` — opens the lease, waiting for the machine
   * (a free claim takes ~2 min). Answers at once if the lease is already open.
   */
  controlOpen(machineId: string): Promise<{ machineId: string; expiresAfterIdleSec: number }> {
    return this.json(this.controlPath(machineId), {
      method: 'POST',
      headers: this.headers(),
      signal: AbortSignal.timeout(240_000),
      prefix: 'Opening control failed',
    })
  }

  /** `POST /v1/machines/:id/control/exec` — runs one Simulang block on the machine. */
  controlExec(machineId: string, code: string, timeoutMs?: number): Promise<ExecResult> {
    return this.json(`${this.controlPath(machineId)}/exec`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ code, ...(timeoutMs !== undefined && { timeoutMs }) }),
      signal: AbortSignal.timeout((timeoutMs ?? 120_000) + 45_000),
      prefix: 'Running the block failed',
    })
  }

  controlInterrupt(machineId: string): Promise<{ interrupted: boolean }> {
    return this.json(`${this.controlPath(machineId)}/interrupt`, {
      method: 'POST',
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
      prefix: 'Interrupt failed',
    })
  }

  async controlClose(machineId: string): Promise<void> {
    await this.request(this.controlPath(machineId), {
      method: 'DELETE',
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
      prefix: 'Closing control failed',
    })
  }

  // ─── OSWorld attempts (docs/plans/2026-10-07-osworld-runner-image.md §8) ───────

  /**
   * `POST /v1/benchmarks/osworld/attempts` — answers at once with state `starting`; the machine
   * and the task's setup follow in the background (poll `osworldGet`).
   */
  osworldStart(taskId: string): Promise<OsworldAttempt> {
    return this.json('/v1/benchmarks/osworld/attempts', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ taskId }),
      signal: AbortSignal.timeout(90_000),
      prefix: 'Starting the OSWorld task failed',
    })
  }

  osworldGet(attemptId: string): Promise<OsworldAttempt> {
    return this.json(`/v1/benchmarks/osworld/attempts/${encodeURIComponent(attemptId)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(90_000),
      prefix: 'Reading the OSWorld attempt failed',
    })
  }

  osworldAskUser(
    attemptId: string,
    question: string,
  ): Promise<{ answer: string | null; note?: string }> {
    return this.json(`/v1/benchmarks/osworld/attempts/${encodeURIComponent(attemptId)}/ask_user`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ question }),
      signal: AbortSignal.timeout(90_000),
      prefix: 'Asking the user failed',
    })
  }

  osworldAbandon(attemptId: string): Promise<OsworldAttempt> {
    return this.json(`/v1/benchmarks/osworld/attempts/${encodeURIComponent(attemptId)}/abandon`, {
      method: 'POST',
      headers: this.headers(),
      signal: AbortSignal.timeout(120_000),
      prefix: 'Abandoning the OSWorld task failed',
    })
  }

  osworldEvaluate(attemptId: string, outcome: 'done' | 'fail' = 'done'): Promise<OsworldAttempt> {
    return this.json(`/v1/benchmarks/osworld/attempts/${encodeURIComponent(attemptId)}/evaluate`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ outcome }),
      signal: AbortSignal.timeout(11 * 60_000),
      prefix: 'Grading the OSWorld task failed',
    })
  }

  /** `GET /auth` — verifies the credential and returns the caller's uid. */
  auth(): Promise<{ ok: boolean; userId: string; authType?: 'firebase' | 'apiKey' }> {
    return this.json('/v1/agents/auth', {
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
      prefix: 'Auth check failed',
    })
  }

  async machines(): Promise<MachineRow[]> {
    const { machines } = await this.json<{ machines: MachineRow[] }>('/v1/agents/machines', {
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
      prefix: 'Failed to list machines',
    })
    return machines
  }

  /**
   * `POST /machines/:id/live` — the caller's machine's screen. `websocketUrl`
   * is a Guacamole tunnel for the task view: it carries a session token and
   * takes input, so hand it to the view only, never to the model or a log.
   * `liveUrl` is a hosted page for a person; `sai_live_link` gives it to the
   * model to pass on.
   */
  liveScreen(machineId: string): Promise<LiveScreen> {
    return this.json(`/v1/agents/machines/${encodeURIComponent(machineId)}/live`, {
      method: 'POST',
      headers: this.headers(),
      signal: AbortSignal.timeout(20_000),
      prefix: 'Live screen unavailable',
    })
  }

  /** GET /models — the catalog a task may name, with per-plan `allowed`. */
  async models(): Promise<{
    models: Array<{
      id: string
      name: string
      provider: string
      tier: string
      costTier: string
      allowed: boolean
    }>
    default: string
  }> {
    const res = await this.request('/v1/agents/models', {
      method: 'GET',
      headers: this.headers(),
      prefix: 'Failed to list models',
    })
    return (await res.json()) as Awaited<ReturnType<SaiApi['models']>>
  }

  /** `POST /new-session` on the `api` channel; returns the fresh sessionId. */
  async newSession(machineId: string): Promise<string> {
    const { sessionId } = await this.json<{ sessionId: string }>('/v1/agents/new-session', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ machineId, channel: 'api' }),
      signal: AbortSignal.timeout(15_000),
      prefix: 'Failed to start a new session',
    })
    return sessionId
  }

  /**
   * Today's path: `POST /message` with the SSE stream (`wait` defaults to
   * true). Returns the open response; the caller parses the body.
   */
  async sendMessageStream(req: StartRequest, signal?: AbortSignal): Promise<Response> {
    const res = await this.request('/v1/agents/message', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
      body: JSON.stringify({
        machineId: req.machineId,
        message: req.message,
        ...(req.attachments && { attachments: req.attachments }),
        ...(req.model && { model: req.model }),
        ...(req.autonomous && { autonomous: true }),
        ...(req.recordTrajectory && { options: { recordTrajectory: true } }),
      }),
      ...(signal && { signal }),
      prefix: 'Failed to send the task',
    })
    if (!res.body) throw new Error('The Sai API returned no response body for the task stream.')
    return res
  }

  /** A1: `POST /message` with `wait: false` → `202 { sessionId, machineId, queued }`. */
  sendMessageNoWait(req: StartRequest): Promise<StartResult> {
    return this.json('/v1/agents/message', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        machineId: req.machineId,
        message: req.message,
        wait: false,
        ...(req.attachments && { attachments: req.attachments }),
        ...(req.model && { model: req.model }),
        ...(req.autonomous && { autonomous: true }),
        ...(req.recordTrajectory && { options: { recordTrajectory: true } }),
      }),
      signal: AbortSignal.timeout(30_000),
      prefix: 'Failed to send the task',
    })
  }

  /** Read the turn itself: session idle can precede turn finalization. */
  turn(turnId: string, signal: AbortSignal): Promise<{ status: string }> {
    return this.json(`/v1/agents/turns/${encodeURIComponent(turnId)}`, {
      headers: this.headers(),
      signal,
      prefix: 'Reading task finalization failed',
    })
  }

  /**
   * `POST /v1/agents/learn` without `maxIterations`: writes the code from recorded turns and
   * answers when it is written, which can take minutes.
   */
  learn(body: {
    turns: string[]
    taskTemplate?: string
    guidance?: string
  }): Promise<Record<string, unknown>> {
    return this.json('/v1/agents/learn', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10 * 60_000),
      prefix: 'Learning code failed',
    })
  }

  /** A2: `GET /events?sessionId&since&wait` — long-polls up to `waitS` (0..60) seconds. */
  events(sessionId: string, since: string | undefined, waitS: number): Promise<EventsResponse> {
    const params = new URLSearchParams({ sessionId, wait: String(waitS) })
    if (since) params.set('since', since)
    return this.json(`/v1/agents/events?${params}`, {
      headers: this.headers(),
      // The server holds for `waitS`; give it headroom before giving up locally.
      signal: AbortSignal.timeout((waitS + 15) * 1000),
      prefix: 'Failed to fetch task events',
    })
  }

  approve(
    approvalId: string,
    response: ApproveResponse,
    selections?: string[][],
  ): Promise<{ ok: boolean; status?: string; note?: string }> {
    return this.json('/v1/agents/approve', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ approvalId, response, ...(selections && { selections }) }),
      signal: AbortSignal.timeout(15_000),
      prefix: 'Failed to resolve the approval',
    })
  }

  /** `POST /abort { sessionId }` — owner-checked on the session doc (cloud-api 36c5e4729). */
  abort(sessionId: string): Promise<{ ok: boolean; aborted: boolean; reason?: string }> {
    return this.json('/v1/agents/abort', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(15_000),
      prefix: 'Failed to abort the task',
    })
  }

  /**
   * `POST /upload`: raw bytes in the body, the original name URL-encoded in
   * `x-filename`. The server derives MIME from the extension and ignores
   * Content-Type.
   */
  upload(name: string, bytes: Uint8Array): Promise<UploadedFile> {
    return this.json('/v1/agents/upload', {
      method: 'POST',
      headers: this.headers({
        'Content-Type': 'application/octet-stream',
        'x-filename': encodeURIComponent(name),
      }),
      body: bytes as unknown as BodyInit,
      signal: AbortSignal.timeout(120_000),
      prefix: 'Upload failed',
    })
  }
}
