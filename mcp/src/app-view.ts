/**
 * MCP Apps (spec 2026-01-26): the Sai task view. Hosts that render MCP Apps
 * (Claude, ChatGPT, Cursor, VS Code Copilot, …) show it under a
 * `sai_task_start` call; hosts that don't (Claude Code, Codex CLI) ignore the
 * metadata and nothing changes for them.
 *
 * - `ui://sai/task-view`: one self-contained HTML page (script inlined at
 *   build time; it talks to its host by postMessage, and connects out only to
 *   the Guacamole proxy for the live screen).
 * - `sai_view_poll`: app-only (`visibility: ["app"]`), so the model never sees
 *   it; the view calls it to follow the task.
 * - `sai_view_live`: app-only; a Guacamole tunnel for the task's live screen.
 *
 * Hosts without MCP Apps get the same page from local-view.ts instead.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import type { TaskLog } from './task-log.js'
import type { WaitResult } from './types.js'

export const TASK_VIEW_URI = 'ui://sai/task-view'
export const MCP_APP_MIME = 'text/html;profile=mcp-app'

/** Linked from `sai_task_start`. `ui/resourceUri` is the pre-1.0 flat key some hosts still read. */
export const TASK_VIEW_TOOL_META = {
  ui: { resourceUri: TASK_VIEW_URI },
  'ui/resourceUri': TASK_VIEW_URI,
}

declare const __SAI_TASK_VIEW_HTML__: string | undefined

/** The built page; a placeholder when running from source (tests, `tsx`). */
export function taskViewHtml(): string {
  return typeof __SAI_TASK_VIEW_HTML__ === 'string'
    ? __SAI_TASK_VIEW_HTML__
    : '<!doctype html><html><body><p>Sai task view (build with npm run build)</p></body></html>'
}

/** Where a person watches the computer: the portal Playground. */
export function playgroundUrl(apiUrl: string): string {
  return /staging/.test(apiUrl)
    ? 'https://staging.platform.simular.cloud/playground'
    : 'https://platform.simular.ai/playground'
}

/** Where the live screen's tunnel connects (prod and staging Guacamole proxies). */
export const LIVE_ORIGINS = [
  'wss://proxy.vm.api.simular.cloud',
  'https://proxy.vm.api.simular.cloud',
  'wss://staging.proxy.vm.api.simular.cloud',
  'https://staging.proxy.vm.api.simular.cloud',
]

/** A view poll waits less than a model wait: hosts time app tool calls out sooner. */
export const VIEW_POLL_TIMEOUT_S = 20

export interface TaskViewDeps {
  wait: (args: { session_id: string; timeout_s?: number; cursor?: string }) => Promise<WaitResult>
  apiUrl: string
  run: (fn: () => Promise<unknown>) => Promise<CallToolResult>
  liveScreen: (
    machineId: string,
  ) => Promise<{ websocketUrl: string; width: number; height: number }>
  tasks: TaskLog
}

const pollArgs = {
  session_id: z.string().min(1),
  cursor: z.string().optional(),
  task_id: z.string().optional(),
}
// Bounds on what a view may park in this process's memory.
const saveArgs = {
  task_id: z.string().min(1),
  snapshot: z.object({
    status: z.string().max(32),
    steps: z
      .array(z.object({ title: z.string().max(400), detail: z.string().max(400).optional() }))
      .max(200),
    text: z.string().max(50_000),
    error: z.string().max(4_000).optional(),
    frame: z
      .string()
      .max(1_500_000)
      .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/)
      .optional(),
  }),
}
const liveArgs = { machine_id: z.string().min(1) }

/**
 * The view's tools, shared by the MCP Apps registration and the local page
 * (local-view.ts). Arguments are parsed here too: the local page doesn't go
 * through the SDK's schema check.
 */
export function taskViewTools(deps: TaskViewDeps): {
  sai_view_poll: (args: unknown) => Promise<CallToolResult>
  sai_view_live: (args: unknown) => Promise<CallToolResult>
  sai_view_save: (args: unknown) => Promise<CallToolResult>
} {
  return {
    sai_view_poll: (raw) =>
      deps.run(async () => {
        const { task_id, ...args } = z.object(pollArgs).parse(raw)
        const playground_url = playgroundUrl(deps.apiUrl)
        // A newer task owns the session's live turn: show what this one saved.
        const state = task_id ? deps.tasks.state(task_id, args.session_id) : 'live'
        const saved = task_id ? deps.tasks.saved(task_id) : undefined
        if (state !== 'live') return { [state]: true, ...(saved && { saved }), playground_url }
        return {
          ...(await deps.wait({ ...args, timeout_s: VIEW_POLL_TIMEOUT_S })),
          ...(saved && { saved }),
          playground_url,
        }
      }),
    sai_view_save: (raw) =>
      deps.run(async () => {
        const args = z.object(saveArgs).parse(raw)
        return { ok: deps.tasks.save(args.task_id, args.snapshot) }
      }),
    sai_view_live: (raw) =>
      deps.run(async () => {
        const args = z.object(liveArgs).parse(raw)
        const live = await deps.liveScreen(args.machine_id)
        return { websocket_url: live.websocketUrl, width: live.width, height: live.height }
      }),
  }
}

export function registerTaskView(mcp: McpServer, deps: TaskViewDeps): void {
  const tools = taskViewTools(deps)
  mcp.registerResource(
    'sai-task-view',
    TASK_VIEW_URI,
    { title: 'Sai task', description: 'Live progress of a Sai task', mimeType: MCP_APP_MIME },
    async () => ({
      contents: [
        {
          uri: TASK_VIEW_URI,
          mimeType: MCP_APP_MIME,
          text: taskViewHtml(),
          // Only the Guacamole proxies, for the live screen's WebSocket tunnel;
          // everything else comes through the host.
          _meta: {
            ui: { csp: { connectDomains: LIVE_ORIGINS, resourceDomains: [] }, prefersBorder: true },
          },
        },
      ],
    }),
  )

  mcp.registerTool(
    'sai_view_poll',
    {
      description:
        'Internal to the Sai task view (MCP Apps). Agents: do not call this; use sai_task_wait.',
      inputSchema: pollArgs,
      _meta: { ui: { resourceUri: TASK_VIEW_URI, visibility: ['app'] } },
    },
    (args) => tools.sai_view_poll(args),
  )

  mcp.registerTool(
    'sai_view_save',
    {
      description:
        "Internal to the Sai task view (MCP Apps): keeps an ended task's view for when it is reopened. Agents: do not call this.",
      inputSchema: saveArgs,
      _meta: { ui: { resourceUri: TASK_VIEW_URI, visibility: ['app'] } },
    },
    (args) => tools.sai_view_save(args),
  )

  mcp.registerTool(
    'sai_view_live',
    {
      description:
        'Internal to the Sai task view (MCP Apps): a view-only live screen tunnel. Agents: do not call this.',
      inputSchema: liveArgs,
      _meta: { ui: { resourceUri: TASK_VIEW_URI, visibility: ['app'] } },
    },
    (args) => tools.sai_view_live(args),
  )
}
