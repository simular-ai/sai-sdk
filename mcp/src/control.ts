/**
 * Direct control tools: Sai API Layer 2, `/v1/machines/:id/control`.
 *
 * Where the task tools hand Sai a goal and Sai looks at the screen, direct
 * control lets the coding agent drive the computer itself: it runs Simulang blocks in
 * a REPL on the machine and gets back the value, the console, and — when a
 * block captured one — a screenshot as MCP image content, so the agent's own
 * model sees the screen on its next turn.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { ExecResult, SaiApi } from './api.js'

/** Under the clients' tool timeouts (Claude Code ~2 min), like sai_task_wait's cap. */
export const EXEC_DEFAULT_S = 90
export const EXEC_MAX_S = 110

/** The core Simulang direct control runs, in one page. Also served as `sai://simulang/reference`. */
export const SIMULANG_REFERENCE = `# Simulang in Sai direct control

Direct control is a JavaScript REPL running ON one cloud computer (Windows, Linux or macOS).
Top-level await works and variables persist between blocks (use \`var\`).
The block's last expression is returned. console.log output comes back in \`logs\`.

## The machine: \`machine\` (already held by your control lease)
Shell and files:
  await machine.exec({ command, cwd?, timeout? })      → { stdout, stderr, exitCode, timedOut }
  await machine.readFile({ path })                      → the file's text
  await machine.writeToFile({ text, path, overwrite? }) APPENDS unless overwrite: true
Screen:
  await machine.pageContent()                           → { text: Snapshot, imageBase64 } of the whole screen; the screen is returned to you as an image
  await machine.ground({ concept, app? })               → { x, y } via a vision model (app crops to its window)
  await machine.stateSatisfies({ condition })           → boolean, via a vision model
Input (coordinates are screen pixels):
  await machine.click({ x, y }) · move · drag({ fromX, fromY, toX, toY })
  await machine.type({ text }) · press({ key }) · shortCut({ key }) · scroll({ direction })
  await machine.copyToClipboard({ text }) · getFromClipboard()
Apps and windows:
  await machine.open({ app?, url? })
  var app = await machine.launch('notepad')             → App
  await machine.getAppWindow(title) → App[] · listWindows() / getWindow(title) / focusedWindow() → Window[]

## Browser (Chrome over DevTools — prefer this for web pages)
  var page = await machine.browser.newtab(url?)         → Page · browser.listTabs() · browser.getTab(id)
  await page.goto({ url }) · page.url() · back() · reload()
  var snap = await page.snapshot()                      → { snapshot: Snapshot, refs, url, title } (+ screenshot)
  await page.click({ ref }) · type({ ref, text, submit? }) · press({ key }) · fill({ fields }) · select({ ref, values })
  await page.scroll({ direction }) · wait({ text? , waitTime? }) · screenshot() · evaluate({ fn })
  await page.find(query) / page.waitFor(query)          → selector match, model fallback

## Native apps (accessibility tree)
  var snap = await app.snapshot()                       → { snapshot: Snapshot, refs } (+ screenshot)
  await app.click({ ref }) · type({ ref, text }) · press({ key }) · scroll({ ref }) · find(query)
Refs come from the LATEST snapshot: snapshot, act, snapshot again.

## Snapshot
  snap.snapshot.outline()   markdown view with refs inline, e.g. [Save](ref=e5)
  snap.snapshot.grep(pattern) · snap.snapshot.read(line, { context: 5 }) · await snap.snapshot.find(query)

## Also
  await wait({ waitTime: 2 })   seconds (unit: 'ms' for milliseconds)
  $lastVisualObservation, $lastAccessibilityObservation, $lastExec

Not available in direct control: sai.*, integrations (google, slack, …), callLLM, askUser,
requestApproval, generateImage, secrets. Do those from your own program.
`

const machineId = z.string().min(1).describe('Cloud computer from sai_machines.')

export const controlToolSchemas = {
  sai_control_open: { machine_id: machineId },
  sai_control_exec: {
    machine_id: z.string().min(1).describe('machine_id passed to sai_control_open.'),
    code: z.string().min(1).describe('Simulang (JavaScript) to run on the machine.'),
    timeout_s: z
      .number()
      .int()
      .min(1)
      .max(EXEC_MAX_S)
      .optional()
      .describe(
        `Seconds the block may run. Default ${EXEC_DEFAULT_S}, max ${EXEC_MAX_S}. Split longer work into several blocks.`,
      ),
  },
  sai_control_interrupt: {
    machine_id: z.string().min(1).describe('Machine whose running block should stop.'),
  },
  sai_control_close: {
    machine_id: z.string().min(1).describe('Machine to release.'),
  },
} as const

export const controlToolDescriptions: Record<keyof typeof controlToolSchemas, string> = {
  sai_control_open:
    'Take direct control of a Sai cloud computer so YOU can drive it by running Simulang (JavaScript) blocks with sai_control_exec. ' +
    'Use this instead of sai_task_start when you want step-by-step control, or want to write a script you can replay. ' +
    'Returns { machine_id, expires_after_idle_s }. Control holds the computer: Sai tasks on it wait until you close it. ' +
    'Calling it again while control is open is fine and returns at once. ' +
    'Can take up to ~2 minutes while the computer starts. Read sai://simulang/reference for the API.',
  sai_control_exec:
    'Run one Simulang block on the computer you control. Returns { result, logs, error?, variables, duration_ms } and, when the block ' +
    'took a screenshot (machine.pageContent(), page/app snapshot or screenshot()), that screenshot as an image. ' +
    'Variables persist between blocks (use `var`). Prefer page.snapshot()/app.snapshot() refs over pixel clicks. ' +
    'error.kind: exception | timeout | interrupted.\n\n' +
    'Quick reference: `await machine.exec({ command })`, `var page = await machine.browser.newtab(url)`, ' +
    '`var snap = await page.snapshot(); snap.snapshot.outline()`, `await page.click({ ref })`, ' +
    '`await machine.pageContent()`, `await machine.ground({ concept })` → { x, y }, `await machine.click({ x, y })`. ' +
    'Full API: resource sai://simulang/reference.',
  sai_control_interrupt:
    'Stop the running block (it ends at its next primitive call or loop iteration). Returns { interrupted }; false means nothing was running.',
  sai_control_close:
    'Release the computer: resets the REPL and frees the computer for Sai tasks. Always close when you are done.',
}

export const controlInstructions = [
  '',
  'Direct control (drive the computer yourself): sai_control_open → sai_control_exec blocks of Simulang → sai_control_close.',
  'Each sai_control_exec result includes a screenshot image when the block captured one. Read sai://simulang/reference first.',
].join('\n')

/** The exec result as the coding agent sees it: text, plus the screenshot as an image block. */
export function execToolResult(r: ExecResult): CallToolResult {
  const { observations, durationMs, ...rest } = r
  const text = { ...rest, duration_ms: durationMs }
  const shot = observations?.screenshot
  return {
    content: [
      { type: 'text', text: JSON.stringify(text, null, 2) },
      ...(shot ? [{ type: 'image' as const, data: shot.base64, mimeType: shot.mimeType }] : []),
    ],
  }
}

export function registerControlTools(
  mcp: McpServer,
  api: SaiApi,
  run: (fn: () => Promise<unknown>) => Promise<CallToolResult>,
  fail: (err: unknown) => CallToolResult,
): void {
  mcp.registerResource(
    'simulang-reference',
    'sai://simulang/reference',
    {
      title: 'Simulang reference (direct control)',
      description: 'The core Simulang API Sai direct control runs.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: SIMULANG_REFERENCE }],
    }),
  )
  mcp.registerTool(
    'sai_control_open',
    {
      description: controlToolDescriptions.sai_control_open,
      inputSchema: controlToolSchemas.sai_control_open,
    },
    (args) =>
      run(async () => {
        const c = await api.controlOpen(args.machine_id)
        return { machine_id: c.machineId, expires_after_idle_s: c.expiresAfterIdleSec }
      }),
  )
  mcp.registerTool(
    'sai_control_exec',
    {
      description: controlToolDescriptions.sai_control_exec,
      inputSchema: controlToolSchemas.sai_control_exec,
    },
    async (args) => {
      try {
        const timeoutMs = (args.timeout_s ?? EXEC_DEFAULT_S) * 1000
        return execToolResult(await api.controlExec(args.machine_id, args.code, timeoutMs))
      } catch (err) {
        return fail(err)
      }
    },
  )
  mcp.registerTool(
    'sai_control_interrupt',
    {
      description: controlToolDescriptions.sai_control_interrupt,
      inputSchema: controlToolSchemas.sai_control_interrupt,
    },
    (args) => run(() => api.controlInterrupt(args.machine_id)),
  )
  mcp.registerTool(
    'sai_control_close',
    {
      description: controlToolDescriptions.sai_control_close,
      inputSchema: controlToolSchemas.sai_control_close,
    },
    (args) =>
      run(async () => {
        await api.controlClose(args.machine_id)
        return { ok: true }
      }),
  )
}
