import { CLOUD_API_URL } from '../config.js'
import { apiFetch } from '../http.js'
import { apiKeySource } from '../auth/token-store.js'

/**
 * Extra guidance appended to a 401 when the key came from ~/.simular/cli/.ak.
 * That key outranks the Firebase session, so a revoked one locks out every
 * command with nothing on screen naming the file. A key from the environment is
 * already in front of the caller, so it's left alone.
 */
function authHint(status: number): string {
  if (status !== 401 || apiKeySource() !== 'file') return ''
  return (
    '\n  This used the API key stored at ~/.simular/cli/.ak, which takes priority over your' +
    '\n  signed-in session. If it has been revoked, run `sai key list` / `sai key revoke <keyId>`,' +
    '\n  or set SAI_API_KEY="" to ignore it for one command.'
  )
}

/**
 * The human-readable part of a cloud-api error body. Newer servers send
 * `{ error: "<code>", message: "<text>" }`; older ones put the text in `error`.
 * Prefers `message`, then `error`, then `fallback` (the status text), so every
 * server generation and a non-JSON body read sensibly.
 */
export function errorDetail(body: unknown, fallback: string): string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (typeof b.message === 'string' && b.message) return b.message
  if (typeof b.error === 'string' && b.error) return b.error
  return fallback
}

/**
 * The Error to throw for a failed cloud-api response: `<prefix> (<status>): <detail>`,
 * plus the stored-key hint on a 401. `detail` is `errorDetail` of the JSON body.
 */
async function apiError(res: Response, prefix: string): Promise<Error> {
  const body: unknown = await res.json().catch(() => ({}))
  const detail = errorDetail(body, res.statusText)
  return new Error(`${prefix} (${res.status}): ${detail}${authHint(res.status)}`)
}

/**
 * The CLI's conversation is the `cli` channel, named on every request that takes one. The
 * server's default follows the credential (`api` for an API key, `cli` for a signed-in token),
 * and `sai` can run with an API key too (`SAI_API_KEY`, `sai key generate`).
 */
export const CLI_CHANNEL = 'cli'

export interface SessionInfo {
  machineId: string
}

export interface MachineInfo {
  machineId: string
  name?: string
  updatedAt: number
}

export interface ResponseMessage {
  role: string
  content: string
  timestamp: number
}

/**
 * Verifies credentials and returns the caller's user identity.
 * A successful response means the token/key is valid and the user is active.
 */
export async function verifyAuth(
  authToken: string,
): Promise<{ userId: string; authType: 'firebase' | 'apiKey' | undefined }> {
  const res = await apiFetch(`${CLOUD_API_URL}/v1/agents/auth`, {
    headers: { Authorization: `Bearer ${authToken}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw await apiError(res, `Auth verification failed`)
  }
  return (await res.json()) as { userId: string; authType: 'firebase' | 'apiKey' | undefined }
}

/**
 * Abort the currently running task on the given machine.
 * Returns { aborted: true } if a task was running and was stopped,
 * { aborted: false, reason } if the agent was already idle.
 */
export async function abortCurrentTask(
  authToken: string,
  machineId: string,
): Promise<{ ok: boolean; aborted: boolean; reason?: string }> {
  const res = await apiFetch(`${CLOUD_API_URL}/v1/agents/abort`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ machineId, channel: CLI_CHANNEL }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw await apiError(res, `Failed to abort task`)
  }
  return (await res.json()) as { ok: boolean; aborted: boolean; reason?: string }
}

export async function resolveSession(authToken: string): Promise<SessionInfo> {
  const res = await apiFetch(`${CLOUD_API_URL}/v1/agents/session?channel=${CLI_CHANNEL}`, {
    headers: { Authorization: `Bearer ${authToken}` },
  })

  if (!res.ok) {
    // 404 here means "no machine registered", not a missing route — worth its own
    // actionable message, so it reads the body itself rather than via apiError.
    if (res.status === 404) {
      const body: unknown = await res.json().catch(() => ({}))
      throw new Error(
        `No machine found for your account. Create a cloud computer in the Sai app or the developer portal, then try again. (${errorDetail(body, res.statusText)})`,
      )
    }
    throw await apiError(res, 'Failed to resolve session')
  }

  return (await res.json()) as SessionInfo
}

export async function listMachines(authToken: string): Promise<MachineInfo[]> {
  const res = await apiFetch(`${CLOUD_API_URL}/v1/agents/machines`, {
    headers: { Authorization: `Bearer ${authToken}` },
  })

  if (!res.ok) {
    throw await apiError(res, `Failed to fetch machines`)
  }

  const { machines } = (await res.json()) as { machines: MachineInfo[] }
  return machines
}

// AI SDK v6 UI Message Stream chunk types (subset used by the sai CLI).
export type SseEvent =
  | { type: 'start'; messageId?: string }
  | { type: 'data-session'; data: { sessionId: string } }
  | { type: 'data-status'; data: { text: string; sessionId?: string } }
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
  | {
      type: 'data-approval-request'
      data: {
        approvalId: string
        title: string
        description: string
        approvalType: string
        isLinkOnly: boolean
        // No always-allow flag: the option it gated wrote `approved_always`,
        // which is legacy read-only now (ADR 0014). "Trust for this task" needs
        // no flag — it is offered on every card the terminal can answer.
        // Present for an exec approval: the raw command (and working directory)
        // the agent wants to run — the full card content, so the prompt shows
        // exactly what's being approved (titles are generic labels).
        command?: string
        cwd?: string
        // Present for an askChoice (`approvalType: 'choice'`) request: every
        // question in the batch, each with its options, whether more than one
        // may be picked, and whether a typed answer counts (`allowOther` — true
        // for a question with no options at all, i.e. a plain free-text ask).
        questions?: Array<{
          message: string
          options: Array<{ value: string; label: string }>
          multiple: boolean
          allowOther: boolean
        }>
        // The first question's options, repeated for servers predating
        // `questions`. Absent for free-text and multi-question asks, which is
        // why `questions` exists.
        options?: Array<{ value: string; label: string }>
        multiple?: boolean
      }
    }
  | { type: 'finish'; finishReason?: string }
  | { type: 'error'; errorText: string }

export interface MessageAttachment {
  path: string
  name: string
  mime: string
  size: number
  fileId: string
}

export interface SessionSummary {
  sessionId: string
  title: string
  updatedAt: number
  active: boolean
}

/** Lists recent chat sessions for a machine (most recent first, up to 20). */
export async function listSessions(
  authToken: string,
  machineId: string,
): Promise<SessionSummary[]> {
  const res = await apiFetch(
    `${CLOUD_API_URL}/v1/agents/sessions?machineId=${encodeURIComponent(machineId)}&channel=${CLI_CHANNEL}`,
    { headers: { Authorization: `Bearer ${authToken}` } },
  )

  if (!res.ok) {
    throw await apiError(res, `Failed to list sessions`)
  }

  const { sessions } = (await res.json()) as { sessions: SessionSummary[] }
  return sessions
}

export interface ConciergeMessage {
  id: string
  role: string
  content: string
  timestamp: number
}

export interface ConciergeMessagesPage {
  /** The CLI's dedicated session, or null before its first message created one. */
  sessionId: string | null
  /**
   * The server's clock when it ran the query. The cursor has to come from the
   * server: `timestamp` is written server-side, so seeding it from the client's
   * Date.now() silently drops every reply whenever the local clock runs fast.
   */
  serverNowMs: number
  messages: ConciergeMessage[]
}

/**
 * Poll the concierge side track for new replies since `sinceMs` (exclusive).
 * `seed` marks a cursor that came from the local clock rather than from a
 * previous response, which lets the server bound how far skew can reach.
 */
export async function fetchConciergeMessages(
  authToken: string,
  machineId: string,
  sinceMs: number,
  opts: { signal?: AbortSignal; limit?: number; seed?: boolean } = {},
): Promise<ConciergeMessagesPage> {
  const params = new URLSearchParams({
    machineId,
    since: String(sinceMs),
  })
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.seed) params.set('seed', '1')
  // Combined, not `??`: every caller passes a stop signal, so a bare fallback
  // is dead code — the timeout never applies and a poll the proxy never answers
  // hangs forever, wedging `inFlight` and killing the side track silently.
  const timeout = AbortSignal.timeout(10_000)
  const res = await apiFetch(`${CLOUD_API_URL}/v1/cli/concierge-messages?${params}`, {
    headers: { Authorization: `Bearer ${authToken}` },
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  })
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}))
    throw new Error(
      `Failed to fetch concierge messages (${res.status}): ${errorDetail(body, res.statusText)}`,
    )
  }
  return (await res.json()) as ConciergeMessagesPage
}

/**
 * Poll cadence: fast while a reply is plausibly imminent, then slow.
 *
 * The concierge writes at most an ack or two, and it writes them within a second
 * or so of the send — after that the feed is almost always empty for the rest of
 * the task. A flat 1s tick cost three Firestore reads per second for the whole
 * stream (~900 on a five-minute task) to deliver nothing, on an endpoint with no
 * rate limit of its own. So: 1s for the window a reply actually lands in, 5s
 * afterwards as a safety net for a late one (an offline agent, a slow classify).
 *
 * The real fix is the single server push feed in
 * docs/plans/2026-08-11-cli-api-channel-split.md; this just stops the interim
 * from being wasteful.
 */
const CONCIERGE_POLL_FAST_INTERVAL_MS = 1_000
const CONCIERGE_POLL_SLOW_INTERVAL_MS = 5_000
const CONCIERGE_POLL_FAST_WINDOW_MS = 15_000

/** Requested explicitly so the poll can tell a full page (more may be waiting)
 *  from a short one — the server's default is otherwise invisible here. */
const CONCIERGE_POLL_LIMIT = 20

/**
 * Poll concierge_messages in parallel with the agent SSE stream. Calls
 * `onConcierge` for each new role=concierge message. Returns a stop() that
 * clears the interval and aborts any in-flight fetch — call it when the agent
 * stream ends (before process.exit, or Windows can STATUS_STACK_BUFFER_OVERRUN).
 */
export function startConciergePoll(args: {
  authToken: string
  machineId: string
  sinceMs: number
  onConcierge: (content: string) => void
}): () => void {
  const { authToken, machineId, onConcierge } = args
  let sinceMs = args.sinceMs
  const seen = new Set<string>()
  let stopped = false
  let inFlight = false
  // The starting cursor is the local clock's guess; every later one is the
  // server's own. Told apart so the server bounds only the guess.
  let cursorFromServer = false
  const ac = new AbortController()

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return
    inFlight = true
    try {
      const { messages, serverNowMs } = await fetchConciergeMessages(
        authToken,
        machineId,
        sinceMs,
        {
          signal: ac.signal,
          limit: CONCIERGE_POLL_LIMIT,
          seed: !cursorFromServer,
        },
      )
      if (stopped) return
      for (const msg of messages) {
        if (seen.has(msg.id)) continue
        seen.add(msg.id)
        if (msg.timestamp > sinceMs) {
          sinceMs = msg.timestamp
          cursorFromServer = true
        }
        if (msg.role === 'concierge' && msg.content.trim()) {
          onConcierge(msg.content)
        }
      }
      // Advance on the SERVER's clock once it has answered, so a skewed local
      // clock can't park the cursor in the future (where nothing new ever
      // matches) or in the past (where every poll re-reads the same window).
      // `seen` still covers the overlap while the cursor catches up.
      //
      // Only on a SHORT page: a full one was truncated at `limit`, and jumping
      // to server-now would skip whatever it cut off for good — `seen` dedupes
      // what came back, it can't recover what didn't. The per-message advance
      // above already moved the cursor, so the next tick picks up the remainder.
      if (messages.length < CONCIERGE_POLL_LIMIT && serverNowMs > sinceMs) {
        sinceMs = serverNowMs
        cursorFromServer = true
      }
    } catch {
      // Best-effort side track — don't fail the agent stream on poll/abort errors.
    } finally {
      inFlight = false
    }
  }

  void tick()

  // setTimeout chain rather than setInterval: the cadence changes once the fast
  // window closes, and re-arming after each tick is what lets it.
  const startedAt = Date.now()
  let handle: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    if (stopped) return
    const delay =
      Date.now() - startedAt < CONCIERGE_POLL_FAST_WINDOW_MS
        ? CONCIERGE_POLL_FAST_INTERVAL_MS
        : CONCIERGE_POLL_SLOW_INTERVAL_MS
    handle = setTimeout(() => {
      void tick().finally(arm)
    }, delay)
    handle.unref?.()
  }
  arm()

  return () => {
    stopped = true
    if (handle) clearTimeout(handle)
    ac.abort()
  }
}

/** Restarts the Sai agent process or the cloud machine. */
export async function restartTarget(
  authToken: string,
  machineId: string,
  target: 'agent' | 'machine',
): Promise<void> {
  const res = await apiFetch(`${CLOUD_API_URL}/v1/agents/restart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ machineId, target, channel: CLI_CHANNEL }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    throw await apiError(res, `Failed to restart ${target}`)
  }
}

export async function startNewSession(authToken: string, machineId: string): Promise<string> {
  const res = await apiFetch(`${CLOUD_API_URL}/v1/agents/new-session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ machineId, channel: CLI_CHANNEL }),
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    throw await apiError(res, `Failed to start new session`)
  }

  const { sessionId } = (await res.json()) as { sessionId: string }
  return sessionId
}

export async function sendApproval(
  authToken: string,
  approvalId: string,
  // The two Grants a card can produce plus a deny: `yes` allows this one
  // request, `task` trusts for the rest of the task. `always` is gone — see
  // docs/adr/0014-a-card-decision-never-persists.md.
  response: 'yes' | 'no' | 'task',
  // For an askChoice (`choice`) approval: the chosen option value(s), one inner
  // array per question (single-question choices send a single inner array).
  selections?: string[][],
): Promise<void> {
  const res = await apiFetch(`${CLOUD_API_URL}/v1/agents/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ approvalId, response, ...(selections && { selections }) }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw await apiError(res, `Failed to send approval`)
  }
}

/**
 * Sends a message to Sai and streams the response via SSE.
 * Calls onEvent for each SSE event received. The callback may be async — if it
 * returns a Promise the loop awaits it before processing the next event (used for
 * interactive approval prompts). Rejects on network/timeout errors.
 *
 * Pass verbose=true to write each received SSE event to stderr for debugging.
 */
export async function streamMessage(
  authToken: string,
  machineId: string,
  message: string,
  timeoutMs: number,
  attachments: MessageAttachment[] | undefined,
  onEvent: (event: SseEvent) => void | Promise<void>,
  verbose?: boolean,
): Promise<void> {
  // Add a 10s buffer over the server-side timeout so the server's finish/error
  // event has time to arrive before the client cuts the connection.
  const clientTimeoutMs = timeoutMs + 10_000
  const inactivityAbort = new AbortController()
  let timedOut = false
  let inactivityTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
    timedOut = true
    inactivityAbort.abort()
  }, clientTimeoutMs)
  const resetInactivityTimer = (): void => {
    clearTimeout(inactivityTimer)
    inactivityTimer = setTimeout(() => {
      timedOut = true
      inactivityAbort.abort()
    }, clientTimeoutMs)
  }
  const timeoutMessage = (): string => {
    const mins = Math.round(timeoutMs / 60_000)
    const label =
      mins >= 1 ? `${mins} minute${mins === 1 ? '' : 's'}` : `${Math.round(timeoutMs / 1000)}s`
    return `Timed out after ${label} with no response from Sai. The task may still be running — check the desktop app. Use --timeout to extend (e.g. --timeout 10m).`
  }

  // `/v1/cli`, not `/v1/agents`: this client is the CLI channel, which gets the
  // concierge side track polled above. `/v1/agents/message` is the generic API
  // lane (pure delivery, its own session) — sending there would silently drop
  // the acks and split `sai`'s conversation off from its own history.
  const res = await apiFetch(`${CLOUD_API_URL}/v1/cli/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ machineId, message, ...(attachments ? { attachments } : {}) }),
    signal: inactivityAbort.signal,
  }).catch((err) => {
    if (timedOut) throw new Error(timeoutMessage())
    throw err
  })

  if (!res.ok) {
    throw await apiError(res, `Request failed`)
  }

  if (!res.body) {
    throw new Error('No response body from server.')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let receivedTerminal = false

  while (true) {
    const { done, value } = await reader.read().catch((err) => {
      if (timedOut) throw new Error(timeoutMessage())
      throw err
    })
    if (done) break

    resetInactivityTimer()

    buffer += decoder.decode(value, { stream: true })

    // SSE messages are separated by double newlines
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? '' // last chunk may be incomplete

    for (const part of parts) {
      const line = part.trim()
      if (!line.startsWith('data: ')) continue
      const jsonStr = line.slice('data: '.length)
      try {
        const event = JSON.parse(jsonStr) as SseEvent
        if (verbose) {
          const summary =
            event.type === 'text-delta'
              ? `text-delta len=${event.delta.length}`
              : event.type === 'data-status'
                ? `data-status: ${event.data.text}`
                : event.type
          process.stderr.write(`[debug] sse event: ${summary}\n`)
        }
        const result = onEvent(event)
        if (result instanceof Promise) await result
        if (event.type === 'finish' || event.type === 'error') {
          receivedTerminal = true
          clearTimeout(inactivityTimer)
          await reader.cancel()
          return
        }
      } catch {
        // ignore malformed lines
      }
    }
  }

  clearTimeout(inactivityTimer)

  if (!receivedTerminal) {
    if (timedOut) throw new Error(timeoutMessage())
    throw new Error(
      'Connection closed unexpectedly. Sai may still be running — check the desktop app.',
    )
  }
}
