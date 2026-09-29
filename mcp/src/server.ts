/**
 * `sai-mcp` — stdio MCP server exposing Sai to coding agents.
 * (The shebang is added by build.mjs's banner, so `tsx src/server.ts` and the
 * bundle both run.)
 * Contract: docs/plans/2026-09-29-sai-api-mvp.md §7 (tools) and §8 (channels).
 *
 * stdout is the MCP transport; every diagnostic goes to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult, ServerNotification } from '@modelcontextprotocol/sdk/types.js'
import { SaiApi } from './api.js'
import { readConfig } from './config.js'
import { EventsPoller, StreamCollector, type SessionSource } from './session-source.js'
import { SaiTools, serverInstructions, toolDescriptions, toolSchemas } from './tools.js'
import { watchSession, type ChannelNotification } from './watcher.js'
import { parseInitClaudeFlags, runInitClaude } from './init-claude.js'

export const SERVER_NAME = 'sai'
export const SERVER_VERSION = '0.1.0'

const log = (line: string): void => {
  process.stderr.write(`[sai-mcp] ${line}\n`)
}

function ok(result: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result as Record<string, unknown>,
  }
}

function fail(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err)
  return { content: [{ type: 'text', text: message }], isError: true }
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn())
  } catch (err) {
    return fail(err)
  }
}

export function createServer(): McpServer {
  const config = readConfig()
  const api = new SaiApi(config.apiUrl, config.apiKey, undefined, config.versionTag)
  const source: SessionSource = config.eventsApi
    ? new EventsPoller(api)
    : new StreamCollector(api, log)
  log(
    `api=${config.apiUrl} transport=${config.eventsApi ? 'events-api' : 'sse-collect'} push=${config.push}`,
  )

  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        // Always declared (§8): presence registers Claude Code's channel
        // listener; harmless on clients that do not know it.
        experimental: { 'claude/channel': {} },
        tools: {},
      },
      instructions: serverInstructions,
    },
  )

  // uid for approval URLs until A3 ships them from the server. Fetched once,
  // lazily, and never fatal — a failed lookup only drops the URL.
  let userIdPromise: Promise<string | undefined> | undefined
  const userId = (): Promise<string | undefined> => {
    userIdPromise ??= api.auth().then(
      (r) => r.userId,
      (err: unknown) => {
        log(`auth lookup failed: ${err instanceof Error ? err.message : String(err)}`)
        userIdPromise = undefined
        return undefined
      },
    )
    return userIdPromise
  }

  const notify = async (n: ChannelNotification): Promise<void> => {
    await mcp.server.notification({
      method: 'notifications/claude/channel',
      params: n,
    } as unknown as ServerNotification)
  }

  const tools = new SaiTools({
    api,
    source,
    push: config.push,
    userId,
    onSessionStarted: (sessionId) => {
      void watchSession(sessionId, {
        source,
        notify,
        withUrl: (a) => tools.withUrl(a),
        log,
      })
    },
  })

  mcp.registerTool(
    'sai_machines',
    { description: toolDescriptions.sai_machines, inputSchema: toolSchemas.sai_machines },
    () => run(() => tools.machines()),
  )
  mcp.registerTool(
    'sai_models',
    { description: toolDescriptions.sai_models, inputSchema: toolSchemas.sai_models },
    () => run(() => tools.models()),
  )
  mcp.registerTool(
    'sai_task_start',
    { description: toolDescriptions.sai_task_start, inputSchema: toolSchemas.sai_task_start },
    (args) => run(() => tools.start(args)),
  )
  mcp.registerTool(
    'sai_task_wait',
    { description: toolDescriptions.sai_task_wait, inputSchema: toolSchemas.sai_task_wait },
    (args) => run(() => tools.wait(args)),
  )
  mcp.registerTool(
    'sai_task_approve',
    { description: toolDescriptions.sai_task_approve, inputSchema: toolSchemas.sai_task_approve },
    (args) => run(() => tools.approve(args)),
  )
  mcp.registerTool(
    'sai_task_abort',
    { description: toolDescriptions.sai_task_abort, inputSchema: toolSchemas.sai_task_abort },
    (args) => run(() => tools.abort(args)),
  )
  mcp.registerTool(
    'sai_upload',
    { description: toolDescriptions.sai_upload, inputSchema: toolSchemas.sai_upload },
    (args) => run(() => tools.upload(args)),
  )

  return mcp
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${SERVER_VERSION}\n`)
    return
  }
  if (command === 'init-claude') {
    const parsed = parseInitClaudeFlags(rest)
    if (!parsed.ok) {
      process.stderr.write(`sai-mcp: ${parsed.error}\n`)
      process.exit(2)
    }
    process.exit(runInitClaude(parsed.options, { version: SERVER_VERSION }))
  }
  const mcp = createServer()
  await mcp.connect(new StdioServerTransport())
}

main().catch((err: unknown) => {
  log(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
