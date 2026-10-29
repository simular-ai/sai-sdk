/**
 * The Sai task view: rendered by MCP Apps hosts (Claude, ChatGPT, Cursor, VS
 * Code Copilot…) under a `sai_task_start` call, or opened in a browser from
 * the `watch_url` sai-mcp serves locally for hosts without MCP Apps. It follows the task with the
 * app-only `sai_view_poll` tool and shows what Sai is doing, approval
 * requests, and the answer. The model never sees any of it.
 */
import {
  HostBridge,
  LocalBridge,
  type DisplayMode,
  type HostContext,
  type ToolResult,
} from './bridge.js'
import { connectLive, showFrame, type DropKind, type LiveHandle } from './live.js'
import { LiveRetry } from './live-retry.js'
import {
  applyPoll,
  headline,
  initialView,
  inlineMarkdown,
  isDone,
  type PollResult,
  type TaskView,
} from './view-model.js'

declare const __SAI_VERSION__: string

// Embedded by an MCP Apps host, or opened directly from sai-mcp's local page.
const bridge = window.parent === window ? new LocalBridge() : new HostBridge()
if (bridge instanceof LocalBridge) document.documentElement.classList.add('standalone')
let view: TaskView = initialView
let cursor: string | undefined
let polling = false
let machineId: string | null = null
let taskId: string | null = null
/** sai-mcp's local page for this task: the same view in its own browser window. */
let watchUrl: string | null = null
/** The live screen's last frame, saved with the view when the task ends. */
let lastFrame: string | undefined
/** What a reopened view of an older task shows instead of the live turn. */
interface Saved {
  status: TaskView['status']
  steps: TaskView['steps']
  text: string
  error?: string
  frame?: string
}
let live: LiveHandle | null = null
let liveLoop = false
/** Growing waits between live-screen asks; reset once the screen connects or a task starts. */
const liveRetry = new LiveRetry()
/** Ends the live loop's current wait early (a new task started, or this one ended). */
let wakeLive: (() => void) | null = null
let displayMode: DisplayMode = 'inline'
let hostModes: DisplayMode[] = []
/**
 * Hosts known to open the local page's http://127.0.0.1 link. Codex accepts
 * `ui/open-link` for it but opens nothing, so the button is opt-in per host.
 */
const OPENS_LOCAL_LINKS = new Set(['Claude'])
let hostName = ''

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const $ = (id: string): HTMLElement => document.getElementById(id)!
const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )

function render(): void {
  $('headline').textContent = headline(view)
  $('dot').className = `dot ${view.status}`
  const steps = view.steps.slice(-12)
  $('steps').innerHTML = steps
    .map(
      (s) =>
        `<li>${esc(s.title)}${s.detail ? `<span class="detail">${esc(s.detail)}</span>` : ''}</li>`,
    )
    .join('')
  $('steps-more').textContent =
    view.steps.length > steps.length ? `${view.steps.length - steps.length} earlier steps` : ''
  $('answer').hidden = !(isDone(view) && view.text)
  $('answer').innerHTML = inlineMarkdown(view.text)
  $('error').hidden = !view.error
  $('error').textContent = view.error ?? ''
  const a = view.approval
  $('approval').hidden = !a
  if (a) {
    $('approval-title').textContent = a.title
    $('approval-text').textContent = a.command ? `${a.description}\n${a.command}` : a.description
    $('approve').hidden = $('approve-task').hidden = $('deny').hidden = a.isLinkOnly
    $('open-approval').hidden = !a.isLinkOnly || !a.approvalUrl
  }
  $('live').hidden = !view.playgroundUrl
  // The screen box: live while the task runs, its last frame after; nothing to show otherwise.
  $('screen-wrap').hidden = !machineId || (isDone(view) && !lastFrame && !live)
  // Nothing will ever draw in a blocked card: keep the note, drop the empty box.
  $('screen').hidden = liveBlocked && !lastFrame
  document.documentElement.dataset.mode = displayMode
  // Offer pip / fullscreen only where the host has them; in either, offer the way back.
  $('pin').hidden = displayMode !== 'inline' || !hostModes.includes('pip')
  $('expand').hidden = displayMode !== 'inline' || !hostModes.includes('fullscreen')
  $('restore').hidden = displayMode === 'inline'
  $('watch-here').hidden = !takenOver || isDone(view)
  // Hosts without pip (Claude): keep it in view by opening it in a window instead.
  $('popout').hidden =
    !(bridge instanceof HostBridge) ||
    !watchUrl ||
    hostModes.includes('pip') ||
    !OPENS_LOCAL_LINKS.has(hostName)
  bridge.sizeChanged(document.documentElement.scrollHeight)
}

function structured(result: ToolResult): Record<string, unknown> | undefined {
  if (result.structuredContent) return result.structuredContent
  const text = result.content?.find((c) => c.type === 'text')?.text
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function restore(saved: Saved | undefined, note?: string): void {
  if (saved) {
    view = {
      ...view,
      status: saved.status,
      steps: saved.steps,
      text: saved.text,
      error: saved.error,
    }
    if (saved.frame) {
      lastFrame = saved.frame
      showFrame($('screen'), saved.frame)
    }
  } else {
    view = { ...view, status: 'idle', text: note ?? '' }
  }
  render()
}

/** Keep the ended task's view in the server, for when this card is reopened. */
function save(): void {
  if (!taskId) return
  const snapshot: Saved = {
    status: view.status,
    steps: view.steps.map(({ title, detail }) => ({ title, ...(detail && { detail }) })),
    text: view.text,
    ...(view.error && { error: view.error }),
    ...(lastFrame && { frame: lastFrame }),
  }
  void bridge.callTool('sai_view_save', { task_id: taskId, snapshot }).catch(() => {})
}

/** Follows the task until it ends; resolves once the first poll says whether it is live. */
async function poll(onFirst: (live: boolean) => void): Promise<void> {
  if (polling || !view.sessionId) return
  polling = true
  let first = true
  const settle = (live: boolean): void => {
    if (first) onFirst(live)
    first = false
  }
  try {
    while (view.sessionId && !isDone(view)) {
      // Each poll is one `/events` request, and that endpoint is rate-limited
      // per account (shared with the agent's own waits): at most one per 4 s.
      const since = Date.now()
      const res = await bridge.callTool('sai_view_poll', {
        session_id: view.sessionId,
        ...(cursor && { cursor }),
        ...(taskId && { task_id: taskId }),
      })
      const data = structured(res) as
        | (PollResult & { archived?: boolean; expired?: boolean; saved?: Saved })
        | undefined
      if (res.isError || !data) {
        await sleep(5_000)
        continue
      }
      if (data.archived || data.expired) {
        view = { ...view, playgroundUrl: data.playground_url ?? view.playgroundUrl }
        restore(
          data.saved,
          data.archived
            ? 'Sai has started another task on this computer since; this one has ended.'
            : "This task's details are no longer available (Sai was restarted).",
        )
        settle(false)
        return
      }
      cursor = data.cursor
      view = applyPoll(view, data)
      // Reopened after it ended: what it saved has the final frame.
      if (first && isDone(view) && data.saved) restore({ ...data.saved, status: view.status })
      render()
      settle(!isDone(view))
      if (!isDone(view)) await sleep(Math.max(0, 4_000 - (Date.now() - since)))
    }
    save()
  } finally {
    polling = false
    // The task ended: let the live loop stop now rather than after its wait.
    wakeLive?.()
  }
}

function screenNote(text: string): void {
  $('screen-note').textContent = text
  $('screen-note').hidden = !text
}

/** The live loop's wait between asks; `wakeLive` cuts it short. */
function liveWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      if (wakeLive === done) wakeLive = null
      resolve()
    }
    const timer = setTimeout(done, ms)
    wakeLive = done
  })
}

async function untilDone(): Promise<'done'> {
  while (!isDone(view)) await sleep(1_000)
  return 'done'
}

/** Set when another viewer took the screen over: no reconnect until "Watch here". */
let takenOver = false
/** The host blocked the live screen's connection (e.g. Codex without network access). */
let liveBlocked = false

/**
 * Keeps the live screen up while the task runs; freezes the last frame when it
 * ends. A machine's screen has one viewer at a time, so two views (this card,
 * the Playground, another app) would knock each other off forever: once another
 * viewer takes over, this one stops and offers to take it back. Other drops,
 * and a computer that isn't up yet (409) or a rate limit (429), retry with a
 * growing delay (live-retry.ts), honouring the server's Retry-After.
 */
async function followScreen(): Promise<void> {
  if (liveLoop || !machineId) return
  liveLoop = true
  takenOver = false
  liveRetry.reset()
  render()
  let blocked = 0
  try {
    while (!isDone(view) && !takenOver) {
      const res = await bridge
        .callTool('sai_view_live', { machine_id: machineId })
        .catch(() => null)
      const data = res && !res.isError ? structured(res) : undefined
      const url = typeof data?.websocket_url === 'string' ? data.websocket_url : null
      if (!url) {
        // 409 while a free computer boots or after it went back to the pool;
        // 429 past the rate limit; or an error. Ask again later, never in a tight loop.
        const rateLimited = data?.status === 429
        const retryAfterS = typeof data?.retry_after_s === 'number' ? data.retry_after_s : undefined
        screenNote(
          rateLimited
            ? 'The live screen is paused for a moment; it will retry.'
            : 'Waiting for the computer to start…',
        )
        await liveWait(liveRetry.delay({ retryAfterS, rateLimited }))
        continue
      }
      screenNote('Connecting to the computer…')
      let handle!: LiveHandle
      const dropped = new Promise<DropKind>((resolve) => {
        handle = connectLive(url, $('screen'), {
          connected: () => {
            liveRetry.reset()
            screenNote('')
          },
          lost: (_reason, kind) => resolve(kind),
        })
      })
      live = handle
      // Stay connected until the stream drops or the task ends (finally keeps the frame).
      const kind = await Promise.race([dropped, untilDone()])
      if (isDone(view)) break
      lastFrame = handle.close(true) ?? lastFrame
      live = null
      // Only Guacamole's own conflict code means another viewer took over. Other
      // drops just retry: a free machine's stream also ends whenever Sai lets go
      // of it between steps, so "dropped twice" is not evidence of a takeover.
      if (kind === 'conflict') {
        takenOver = true
        break
      }
      if (kind === 'blocked' && ++blocked >= 2) {
        // The host keeps this view off the network; retrying won't change that.
        // Codex: its in-app browser does open the watch link from the chat.
        screenNote(
          watchUrl
            ? "This app keeps the card offline, so the screen can't show here. Open the live view link in the chat, or the Playground."
            : "This app keeps the card offline, so the screen can't show here. Watch it in the Playground.",
        )
        liveBlocked = true
        break
      }
      if (kind === 'unreachable') {
        // Asleep or waking: Sai wakes it for the task; check back with growing waits.
        screenNote('Waiting for the computer to wake up…')
        await liveWait(liveRetry.delay())
        continue
      }
      screenNote('Reconnecting…')
      await liveWait(liveRetry.delay())
    }
  } finally {
    lastFrame = live?.close(true) ?? lastFrame
    live = null
    liveLoop = false
    if (!liveBlocked) screenNote(takenOver && !isDone(view) ? 'Being watched somewhere else.' : '')
    // The poll saved before the frame existed: save again with it.
    if (lastFrame && isDone(view)) save()
    render()
  }
}

async function decide(decision: 'approve' | 'approve_for_task' | 'deny'): Promise<void> {
  const a = view.approval
  if (!a) return
  view = { ...view, approval: undefined, status: 'running' }
  render()
  await bridge.callTool('sai_task_approve', { approval_id: a.approvalId, decision }).catch(() => {})
  void poll(() => {})
}

bridge.onToolResult = (result) => {
  const data = structured(result)
  const sessionId = typeof data?.session_id === 'string' ? data.session_id : null
  if (!sessionId || sessionId === view.sessionId) return
  view = { ...initialView, sessionId, status: 'running' }
  cursor = undefined
  machineId = typeof data?.machine_id === 'string' ? data.machine_id : null
  taskId = typeof data?.task_id === 'string' ? data.task_id : null
  watchUrl = typeof data?.watch_url === 'string' ? data.watch_url : null
  // A running live loop picks up the new machine: ask for it now, from a short wait.
  liveRetry.reset()
  wakeLive?.()
  render()
  // Only a task still running gets the live screen; an ended one shows its saved frame.
  void poll((live) => {
    if (live) void followScreen()
  })
}

function applyContext(ctx: HostContext | undefined): void {
  if (!ctx) return
  if (ctx.theme) document.documentElement.dataset.theme = ctx.theme
  if (ctx.availableDisplayModes) hostModes = ctx.availableDisplayModes
  if (ctx.displayMode) displayMode = ctx.displayMode
  render()
}
bridge.onHostContext = applyContext

async function switchMode(mode: DisplayMode): Promise<void> {
  displayMode = await bridge.requestDisplayMode(mode).catch(() => displayMode)
  render()
}
$('pin').onclick = () => void switchMode('pip')
$('watch-here').onclick = () => void followScreen()
$('popout').onclick = () => watchUrl && bridge.openLink(watchUrl)
$('expand').onclick = () => void switchMode('fullscreen')
$('restore').onclick = () => void switchMode('inline')

$('approve').onclick = () => void decide('approve')
$('approve-task').onclick = () => void decide('approve_for_task')
$('deny').onclick = () => void decide('deny')
$('open-approval').onclick = () =>
  view.approval?.approvalUrl && bridge.openLink(view.approval.approvalUrl)
$('live').onclick = () => view.playgroundUrl && bridge.openLink(view.playgroundUrl)

void bridge
  .connect(typeof __SAI_VERSION__ === 'string' ? __SAI_VERSION__ : 'dev')
  .then((init) => {
    hostName = init.hostInfo?.name ?? ''
    applyContext(init.hostContext)
    render()
  })
  .catch(() => render())
