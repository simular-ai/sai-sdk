import { readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { z } from 'zod'
import { ApiError, type ApproveResponse, type SaiApi } from './api.js'
import { APPROVAL_URL_BASE } from './config.js'
import type { SessionSource } from './session-source.js'
import type { ApprovalRequest, MachineRow, UploadedFile, WaitResult } from './types.js'

// ─── Schemas (§7) ─────────────────────────────────────────────────────────────

export const WAIT_DEFAULT_S = 90
/** Under Claude Code's 2-minute auto-background threshold with headroom for the HTTP round trip. */
export const WAIT_MAX_S = 110

export const decisionSchema = z.enum(['approve', 'approve_for_task', 'deny'])
export type Decision = z.infer<typeof decisionSchema>

export const toolSchemas = {
  sai_machines: {},
  sai_task_start: {
    task: z.string().min(1).describe('What Sai should do, in plain language. Be specific.'),
    machine_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Target machine from sai_machines. Optional when the account has exactly one machine.',
      ),
    file_ids: z
      .array(z.string().min(1))
      .optional()
      .describe('file_id values returned by sai_upload in this server process, to attach.'),
    new_session: z
      .boolean()
      .optional()
      .describe(
        'true = clear the conversation on this machine first. Default false: the task continues the existing api-channel conversation, so Sai remembers earlier tasks.',
      ),
    model: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Model id from sai_models (or "auto"). Sticks to the session until changed. Omit to keep the account default.',
      ),
  },
  sai_models: {},
  sai_task_wait: {
    session_id: z.string().min(1).describe('session_id from sai_task_start.'),
    timeout_s: z
      .number()
      .int()
      .min(1)
      .max(WAIT_MAX_S)
      .optional()
      .describe(`Seconds to block for. Default ${WAIT_DEFAULT_S}, max ${WAIT_MAX_S}.`),
    cursor: z
      .string()
      .optional()
      .describe('cursor from the previous sai_task_wait result; omit on the first call.'),
  },
  sai_task_approve: {
    approval_id: z.string().min(1).describe('approval.approvalId from a needs_approval result.'),
    decision: decisionSchema.describe(
      'approve = allow this one request; approve_for_task = trust similar requests for the rest of this task; deny = refuse.',
    ),
    selections: z
      .array(z.array(z.string()))
      .optional()
      .describe(
        'For approvalType "choice" only: one inner array per question, holding the chosen option values (or free text when allowOther). Required to approve a choice.',
      ),
  },
  sai_task_abort: {
    session_id: z.string().min(1).describe('session_id from sai_task_start.'),
  },
  sai_upload: {
    path: z.string().min(1).describe('Absolute or cwd-relative path of a local file (max 25 MB).'),
  },
} as const

// ─── Descriptions ─────────────────────────────────────────────────────────────

// Scoped to the task tools: in a task, Sai sees the screen and reports back in
// text. The session tools (sessions.ts, when enabled) do return screenshots.
const NO_SCREENSHOT =
  'Task tools return no screenshots: Sai sees the screen itself and reports back in text.'

export const toolDescriptions: Record<keyof typeof toolSchemas, string> = {
  sai_machines:
    "List the Sai machines (cloud computers or the user's own desktops) this account can drive. " +
    'Returns { machines: [{ machineId, name, kind?, online? }], default? } — `default` is set when there is exactly one machine, ' +
    'in which case sai_task_start may omit machine_id. Call this once per conversation, not before every task. ' +
    'An empty list means the account has no computer yet: this server cannot create one (it costs money and needs ' +
    'the signed-in user), so send the user to https://platform.simular.ai/playground to create it in one click.',
  sai_models:
    'List the models Sai can run a task with: { models: [{ id, name, provider, tier, costTier, allowed }], default }. ' +
    "`allowed` is per plan (free accounts have an allowlist). Pass an id as sai_task_start.model to switch the session's model; " +
    '"auto" lets Sai pick. Only call this when the user asks for a specific model or a task needs a stronger/faster one.',
  sai_task_start:
    'Send a task to Sai, an autonomous computer-use agent that operates a real Windows/macOS desktop (browser, apps, files) on the chosen machine. ' +
    'Use it for work that needs a screen or the user\'s logged-in accounts, e.g. "Log in to the vendor portal and list last month\'s invoices with totals" or "Follow this bug report in Chrome and describe what happens at each step". ' +
    'Returns { session_id, machine_id, queued, push, watch_url? } immediately; the task keeps running on the machine. ' +
    'watch_url is a local page where the user can watch the computer live and approve steps: always give it to the user as a clickable link (some apps can only show the screen there). ' +
    'Then call sai_task_wait with session_id until status is not "running" — UNLESS push is true, in which case do NOT call sai_task_wait: ' +
    'the result arrives as a channel notification and you should continue with other work. ' +
    'One conversation per machine persists on the "api" channel across calls (Sai remembers earlier tasks and their results); pass new_session: true to start clean. ' +
    'queued: true means Sai was busy and the message was parked as a steer for the running task. ' +
    NO_SCREENSHOT,
  sai_task_wait:
    'Block up to timeout_s (default 90, max 110) for the task to leave the "running" state. ' +
    'Returns { status, events, text, approval?, usage?, sessionUsage?, cursor, error? }. usage is this task\'s model tokens and cost so far (inputTokens, outputTokens, cacheReadTokens, costUsd, byModel); sessionUsage is the same across the session\'s tasks.  status: "running" = timed out, call again passing the returned cursor; ' +
    '"needs_approval" = Sai is paused on `approval` — if approval.isLinkOnly is false decide with sai_task_approve, if true give approval.approvalUrl to the human and call sai_task_wait again; ' +
    '"idle" = done, `text` is Sai\'s answer; "error" = failed, see `error`. ' +
    '`text` is the assistant text of the whole turn so far; `events` are only the frames since `cursor`. ' +
    NO_SCREENSHOT,
  sai_task_approve:
    'Resolve a pending approval from a needs_approval result. decision: approve | approve_for_task | deny. ' +
    'For approvalType "choice" pass `selections` with the chosen option values. ' +
    'Returns { ok: true } or, when the approval can only be completed by a human in a browser (OAuth consent, credentials, phone verification), ' +
    '{ ok: false, reason: "link_only", approval_url } — hand approval_url to the human, then keep waiting. ' +
    'Only approve actions the user has actually asked for; when in doubt, ask the human.',
  sai_task_abort:
    'Stop the task running in this session. Returns { ok, aborted, reason? }; aborted: false with a reason means nothing was running. Safe to call twice.',
  sai_upload:
    'Upload a local file (max 25 MB) so Sai can use it. Returns { file_id, name, mime, size }; pass file_id in sai_task_start.file_ids. ' +
    "The uploaded file lands in the machine's Sai files, not at the original path.",
}

export const serverInstructions = [
  "Sai is an autonomous computer-use agent that operates a real desktop (browser, native apps, files, email) on the user's Sai machine.",
  "Use it when the work needs a screen: sites and apps with no API (vendor portals, admin consoles, legacy web apps), web apps behind the user's logins (sign-ins go to the human as an approval link), desktop software on Windows, macOS or Linux, or seeing what a real user sees (testing a sign-up flow, reproducing a bug). Don't use it for what you can do locally or through an API.",
  'For a workflow the user will repeat, ask Sai after the first run to save it as a replayable skill with parameters ("Save this as a replayable skill named invoice_export, with vendor and month as parameters"); later, ask Sai to run that skill. Sai replays it as code, asking the model only where the screen matters, and the agent takes over if the UI changed.',
  '',
  'The loop:',
  '1. sai_machines once (skip when you already know the machine_id).',
  '2. sai_task_start { task, machine_id? } → session_id. Write the task as you would brief a capable colleague: goal, constraints, what to report back.',
  '3. sai_task_wait { session_id } and repeat while status is "running", passing the returned cursor each time.',
  '   - needs_approval: read `approval`. isLinkOnly false → sai_task_approve (approve / approve_for_task / deny; "choice" needs selections). isLinkOnly true → give approval.approvalUrl to the human, then wait again.',
  '   - idle: `text` is the answer. Report it to the user.',
  '   - error: report `error`; sai_task_start again to retry or rephrase.',
  '4. sai_task_abort to stop a task the user no longer wants.',
  '',
  'One conversation per machine persists on the "api" channel across calls, so follow-up tasks can refer to earlier ones; pass new_session: true when the topic changes.',
  'If sai_task_start returns push: true, do NOT call sai_task_wait — a channel notification (<channel source="sai" session_id=... event=...>) delivers needs_approval / idle / error; continue other work meanwhile.',
  NO_SCREENSHOT,
].join('\n')

// ─── Handlers ─────────────────────────────────────────────────────────────────

export interface ToolContext {
  api: SaiApi
  source: SessionSource
  push: boolean
  /** Started when `push` is on; the server watches the session and notifies. */
  onSessionStarted?: (sessionId: string) => void
  /** Resolves the caller's uid (cached) for approval URLs until A3 ships. */
  userId: () => Promise<string | undefined>
}

export function decisionToResponse(decision: Decision): ApproveResponse {
  switch (decision) {
    case 'approve':
      return 'yes'
    case 'approve_for_task':
      return 'task'
    case 'deny':
      return 'no'
  }
}

export function clampTimeoutS(timeoutS: number | undefined): number {
  if (timeoutS === undefined || !Number.isFinite(timeoutS)) return WAIT_DEFAULT_S
  return Math.min(WAIT_MAX_S, Math.max(1, Math.floor(timeoutS)))
}

export function buildApprovalUrl(userId: string, approvalId: string): string {
  return `${APPROVAL_URL_BASE}/${encodeURIComponent(userId)}/${encodeURIComponent(approvalId)}`
}

export function machinesResult(rows: MachineRow[]): {
  machines: Array<Pick<MachineRow, 'machineId' | 'name' | 'kind' | 'online' | 'status'>>
  default?: string
} {
  const machines = rows.map((m) => ({
    machineId: m.machineId,
    ...(m.name !== undefined && { name: m.name }),
    ...(m.kind !== undefined && { kind: m.kind }),
    ...(m.online !== undefined && { online: m.online }),
    // Pre-A4 servers send `status` instead of `online`; pass it through rather than guess.
    ...(m.online === undefined && m.status !== undefined && { status: m.status }),
  }))
  const only = machines.length === 1 ? machines[0] : undefined
  return { machines, ...(only && { default: only.machineId }) }
}

export class SaiTools {
  /** Uploads made in this process, keyed by fileId — `/message` needs the full attachment row. */
  private readonly uploads = new Map<string, UploadedFile>()

  constructor(private readonly ctx: ToolContext) {}

  async machines(): Promise<ReturnType<typeof machinesResult>> {
    return machinesResult(await this.ctx.api.machines())
  }

  async models(): Promise<Awaited<ReturnType<SaiApi['models']>>> {
    return this.ctx.api.models()
  }

  private async resolveMachineId(machineId: string | undefined): Promise<string> {
    if (machineId) return machineId
    const rows = await this.ctx.api.machines()
    if (rows.length === 1) return rows[0]!.machineId
    if (rows.length === 0) {
      throw new Error(
        'This account has no computer yet. Ask the user to create one: one click at ' +
          'https://platform.simular.ai/playground (a paid plan creates its own cloud computer; ' +
          'the free plan gets one automatically on its first task). Then call sai_machines again.',
      )
    }
    const list = rows.map((m) => `${m.machineId}${m.name ? ` (${m.name})` : ''}`).join(', ')
    throw new Error(`machine_id is required: this account has ${rows.length} machines: ${list}`)
  }

  async start(args: {
    task: string
    machine_id?: string
    file_ids?: string[]
    new_session?: boolean
    model?: string
  }): Promise<{ session_id: string; machine_id: string; queued: boolean; push: boolean }> {
    const machineId = await this.resolveMachineId(args.machine_id)
    const attachments = args.file_ids?.map((id) => {
      const file = this.uploads.get(id)
      if (!file) {
        throw new Error(
          `Unknown file_id ${id}: only files uploaded with sai_upload in this MCP server process can be attached.`,
        )
      }
      return file
    })
    if (args.new_session) await this.ctx.api.newSession(machineId)
    const started = await this.ctx.source.start({
      machineId,
      message: args.task,
      ...(attachments && attachments.length > 0 && { attachments }),
      ...(args.model && { model: args.model }),
    })
    if (this.ctx.push) this.ctx.onSessionStarted?.(started.sessionId)
    return {
      session_id: started.sessionId,
      machine_id: started.machineId,
      queued: started.queued,
      push: this.ctx.push,
    }
  }

  async wait(
    args: {
      session_id: string
      timeout_s?: number
      cursor?: string
    },
    opts: { returnOnEvents?: boolean } = {},
  ): Promise<WaitResult> {
    const result = await this.ctx.source.wait(args.session_id, {
      timeoutMs: clampTimeoutS(args.timeout_s) * 1000,
      ...(args.cursor !== undefined && { cursor: args.cursor }),
      ...(opts.returnOnEvents && { returnOnEvents: true }),
    })
    return this.decorate(result)
  }

  /** Fills `approvalUrl` on a buffered link-only approval if the server sent none. */
  async decorate(result: WaitResult): Promise<WaitResult> {
    if (!result.approval) return result
    return { ...result, approval: await this.withUrl(result.approval) }
  }

  async withUrl(approval: ApprovalRequest): Promise<ApprovalRequest> {
    // Only link-only approvals are completed on the page; others are answered in place.
    if (approval.approvalUrl || !approval.isLinkOnly) return approval
    const uid = await this.ctx.userId()
    return uid ? { ...approval, approvalUrl: buildApprovalUrl(uid, approval.approvalId) } : approval
  }

  async approve(args: {
    approval_id: string
    decision: Decision
    selections?: string[][]
  }): Promise<
    | { ok: true; status?: string; note?: string }
    | { ok: false; reason: 'link_only'; approval_url?: string }
  > {
    const known = this.ctx.source.findApproval(args.approval_id)
    if (known?.approval.isLinkOnly) {
      const { approvalUrl } = await this.withUrl(known.approval)
      return { ok: false, reason: 'link_only', ...(approvalUrl && { approval_url: approvalUrl }) }
    }
    try {
      const res = await this.ctx.api.approve(
        args.approval_id,
        decisionToResponse(args.decision),
        args.selections,
      )
      this.ctx.source.noteApprovalResolved(args.approval_id)
      return {
        ok: true,
        ...(res.status && { status: res.status }),
        ...(res.note && { note: res.note }),
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body.error === 'link_only') {
        const fromServer =
          typeof err.body.approvalUrl === 'string' ? err.body.approvalUrl : undefined
        const uid = fromServer ? undefined : await this.ctx.userId()
        const url = fromServer ?? (uid ? buildApprovalUrl(uid, args.approval_id) : undefined)
        return { ok: false, reason: 'link_only', ...(url && { approval_url: url }) }
      }
      throw err
    }
  }

  async abort(args: {
    session_id: string
  }): Promise<{ ok: boolean; aborted: boolean; reason?: string }> {
    // Owner-checked server side, so a session from an earlier server process aborts too.
    return this.ctx.api.abort(args.session_id)
  }

  async upload(args: {
    path: string
  }): Promise<{ file_id: string; name: string; mime: string; size: number }> {
    const filePath = resolve(args.path)
    const info = await stat(filePath).catch(() => undefined)
    if (!info?.isFile()) throw new Error(`File not found: ${filePath}`)
    if (info.size > 25 * 1024 * 1024) {
      throw new Error(`File is ${Math.round(info.size / (1024 * 1024))} MB; the maximum is 25 MB.`)
    }
    const bytes = await readFile(filePath)
    const uploaded = await this.ctx.api.upload(basename(filePath), bytes)
    this.uploads.set(uploaded.fileId, uploaded)
    return {
      file_id: uploaded.fileId,
      name: uploaded.name,
      mime: uploaded.mime,
      size: uploaded.size,
    }
  }
}
