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
 * The Error to throw for a failed cloud-api response: `<prefix> (<status>): <detail>`,
 * plus the stored-key hint on a 401. `detail` prefers the JSON `error` field and
 * falls back to the status text, so a non-JSON body still reads sensibly.
 */
async function apiError(res: Response, prefix: string): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  const detail = body.error ?? res.statusText
  return new Error(`${prefix} (${res.status}): ${detail}${authHint(res.status)}`)
}

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
    body: JSON.stringify({ machineId }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw await apiError(res, `Failed to abort task`)
  }
  return (await res.json()) as { ok: boolean; aborted: boolean; reason?: string }
}

export async function resolveSession(authToken: string): Promise<SessionInfo> {
  const res = await apiFetch(`${CLOUD_API_URL}/v1/agents/session`, {
    headers: { Authorization: `Bearer ${authToken}` },
  })

  if (!res.ok) {
    // 404 here means "no machine registered", not a missing route — worth its own
    // actionable message, so it reads the body itself rather than via apiError.
    if (res.status === 404) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(
        `No machine found for your account. Open the Sai desktop app first, then try again. (${body.error ?? res.statusText})`,
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
  | { type: 'data-status'; data: { text: string } }
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
        allowAlways: boolean
      }
    }
  | { type: 'finish'; finishReason?: string }
  | { type: 'error'; errorText: string }

export interface MessageAttachment {
  path: string
  name: string
  mime: string
  size: number
  downloadUrl: string
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
    `${CLOUD_API_URL}/v1/agents/sessions?machineId=${encodeURIComponent(machineId)}`,
    { headers: { Authorization: `Bearer ${authToken}` } },
  )

  if (!res.ok) {
    throw await apiError(res, `Failed to list sessions`)
  }

  const { sessions } = (await res.json()) as { sessions: SessionSummary[] }
  return sessions
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
    body: JSON.stringify({ machineId, target }),
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
    body: JSON.stringify({ machineId }),
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
  response: 'yes' | 'no' | 'always',
): Promise<void> {
  const res = await apiFetch(`${CLOUD_API_URL}/v1/agents/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ approvalId, response }),
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

  const res = await apiFetch(`${CLOUD_API_URL}/v1/agents/message`, {
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
