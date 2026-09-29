import type { SessionSource } from './session-source.js'
import type { ApprovalRequest, WaitResult } from './types.js'

/**
 * `notifications/claude/channel` payload (Claude Code channels reference).
 * `meta` keys must be identifier-safe — letters, digits, underscores — or
 * Claude Code drops them silently, so they are snake_case here on purpose.
 */
export interface ChannelNotification {
  content: string
  meta: Record<string, string>
}

export interface WatchDeps {
  source: SessionSource
  notify: (n: ChannelNotification) => Promise<void>
  /** Fills `approvalUrl` until A3 ships it. */
  withUrl: (approval: ApprovalRequest) => Promise<ApprovalRequest>
  log?: (line: string) => void
  /** Per-iteration wait; a test can shorten it. */
  pollMs?: number
}

export function notificationFor(sessionId: string, result: WaitResult): ChannelNotification {
  const meta: Record<string, string> = { session_id: sessionId, event: result.status }
  if (result.status === 'needs_approval' && result.approval) {
    const a = result.approval
    meta.approval_id = a.approvalId
    if (a.approvalUrl) meta.approval_url = a.approvalUrl
    const lines = [
      `Sai needs ${a.isLinkOnly ? 'the human to complete a step' : 'an approval'}: ${a.title}`,
    ]
    if (a.description) lines.push(a.description)
    if (a.command) lines.push(`Command: ${a.command}${a.cwd ? ` (in ${a.cwd})` : ''}`)
    if (a.isLinkOnly && a.approvalUrl) lines.push(`Open: ${a.approvalUrl}`)
    else lines.push(`Decide with sai_task_approve { approval_id: "${a.approvalId}" }.`)
    if (result.text) lines.push('', 'Text so far:', result.text)
    return { content: lines.join('\n'), meta }
  }
  if (result.status === 'error') {
    return {
      content: `Sai task failed: ${result.error ?? 'unknown error'}${result.text ? `\n\nText so far:\n${result.text}` : ''}`,
      meta,
    }
  }
  return { content: result.text || '(Sai finished the task without a text reply.)', meta }
}

/**
 * SAI_PUSH mode: hold the session's wait loop in-process and push a channel
 * notification on needs_approval (once per approval id), idle and error.
 * After announcing an approval it keeps waiting through `needs_approval` so
 * the human's decision — from any surface — resumes delivery.
 */
export function watchSession(sessionId: string, deps: WatchDeps): Promise<void> {
  const log = deps.log ?? (() => {})
  const pollMs = deps.pollMs ?? 60_000
  const announced = new Set<string>()
  return (async () => {
    let cursor: string | undefined
    for (;;) {
      let result: WaitResult
      try {
        result = await deps.source.wait(sessionId, {
          timeoutMs: pollMs,
          ...(cursor !== undefined && { cursor }),
          waitWhile: announced.size > 0 ? ['running', 'needs_approval'] : ['running'],
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log(`watch ${sessionId}: wait failed: ${message}`)
        await deps.notify({
          content: `Lost track of Sai session ${sessionId}: ${message}`,
          meta: { session_id: sessionId, event: 'error' },
        })
        return
      }
      cursor = result.cursor
      if (result.status === 'running') continue
      if (result.status === 'needs_approval') {
        const id = result.approval?.approvalId
        if (!id || announced.has(id)) continue
        announced.add(id)
        const decorated = result.approval
          ? { ...result, approval: await deps.withUrl(result.approval) }
          : result
        await deps.notify(notificationFor(sessionId, decorated))
        continue
      }
      await deps.notify(notificationFor(sessionId, result))
      return
    }
  })()
}
