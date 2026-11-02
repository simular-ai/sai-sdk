/**
 * The Sai task view: rendered by MCP Apps hosts (Claude, ChatGPT, Cursor, VS
 * Code Copilot…) under a `sai_task_start` call, or opened in a browser from
 * the `watch_url` sai-mcp serves locally for hosts without MCP Apps. It follows the task with the
 * app-only `sai_view_poll` tool and shows what Sai is doing, approval
 * requests, and the answer. The model never sees any of it.
 *
 * The screen takes the person's mouse and keyboard whenever Sai isn't working
 * on it: while a task waits for their approval (often a sign-in only they can
 * do), and after it ends, once they choose to use the computer.
 */
import {
  HostBridge,
  LocalBridge,
  type DisplayMode,
  type HostContext,
  type ToolResult,
} from './bridge.js'
import { connectLive, showFrame, type DropKind, type LiveHandle } from './live.js'
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
/** The stream is up and drawing. */
let liveConnected = false
/** The task has ended and the person asked to use the computer: keep the screen live. */
let using = false
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

/** Sai isn't working on the computer, so the person may: it waits on them, or the task is over. */
const inputAllowed = (): boolean => view.status === 'needs_approval' || isDone(view)

function render(): void {
  live?.setInput(liveConnected && inputAllowed())
  $('input-note').hidden = !liveConnected
  $('input-note').textContent = inputAllowed()
    ? 'Click the screen to use the mouse and keyboard. Control+Alt+Escape gives the keys back.'
    : 'Sai is working. Input is paused until it finishes.'
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
  $('screen-wrap').hidden = !machineId || (isDone(view) && !lastFrame && !live && !using)
  // Nothing will ever draw in a blocked card: keep the note, drop the empty box.
  $('screen').hidden = liveBlocked && !lastFrame
  document.documentElement.dataset.mode = displayMode
  // Offer pip / fullscreen only where the host has them; in either, offer the way back.
  $('pin').hidden = displayMode !== 'inline' || !hostModes.includes('pip')
  $('expand').hidden = displayMode !== 'inline' || !hostModes.includes('fullscreen')
  $('restore').hidden = displayMode === 'inline'
  $('watch-here').hidden = !takenOver || isDone(view)
  $('use').hidden = !isDone(view) || !machineId || liveLoop || liveBlocked
  $('stop-use').hidden = !using
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
  }
}

function screenNote(text: string): void {
  $('screen-note').textContent = text
  $('screen-note').hidden = !text
}

/** Keep the screen live: the task runs, or the person is using the computer after it. */
const keepLive = (): boolean => !isDone(view) || using

async function untilEnd(): Promise<'end'> {
  while (keepLive()) await sleep(1_000)
  return 'end'
}

/** Why using the computer after the task stopped, shown once the screen closes. */
let endNote: string | undefined

/** After the task, the computer may be asleep or taken back: say so and stop, don't wait on it. */
function stopUsing(): void {
  using = false
  endNote = "The computer isn't running now. Send Sai a task to start it."
}

/** Set when another viewer took the screen over: no reconnect until "Watch here". */
let takenOver = false
/** The host blocked the live screen's connection (e.g. Codex without network access). */
let liveBlocked = false

/**
 * Keeps the live screen up while the task runs, or while the person uses the
 * computer after it; freezes the last frame when that ends. A machine's screen
 * has one viewer at a time, so two views (this card, the Playground, another
 * app) would knock each other off forever: once another viewer takes over, this
 * one stops and offers to take it back. Other drops retry with a growing delay.
 */
async function followScreen(): Promise<void> {
  if (liveLoop || !machineId) return
  liveLoop = true
  takenOver = false
  render()
  let delay = 3_000
  let blocked = 0
  try {
    while (keepLive() && !takenOver) {
      const res = await bridge
        .callTool('sai_view_live', { machine_id: machineId })
        .catch(() => null)
      const data = res && !res.isError ? structured(res) : undefined
      const url = typeof data?.websocket_url === 'string' ? data.websocket_url : null
      if (!url) {
        if (isDone(view)) {
          stopUsing()
          break
        }
        screenNote('Waiting for the computer to start…')
        await sleep(8_000)
        continue
      }
      screenNote('Connecting to the computer…')
      let handle!: LiveHandle
      const dropped = new Promise<DropKind>((resolve) => {
        handle = connectLive(url, $('screen'), {
          connected: () => {
            delay = 3_000
            liveConnected = true
            screenNote('')
            render()
          },
          lost: (_reason, kind) => {
            liveConnected = false
            resolve(kind)
          },
        })
      })
      live = handle
      // Stay connected until the stream drops or the task ends (finally keeps the frame).
      const kind = await Promise.race([dropped, untilEnd()])
      if (!keepLive()) break
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
      if (kind === 'unreachable' && isDone(view)) {
        stopUsing()
        break
      }
      if (kind === 'unreachable') {
        // Asleep or waking: Sai wakes it for the task; check back at a steady pace.
        screenNote('Waiting for the computer to wake up…')
        await sleep(8_000)
        continue
      }
      screenNote('Reconnecting…')
      await sleep(delay)
      delay = Math.min(delay * 2, 30_000)
    }
  } finally {
    lastFrame = live?.close(true) ?? lastFrame
    live = null
    liveConnected = false
    liveLoop = false
    using = false
    if (!liveBlocked) screenNote(endNote ?? (takenOver ? 'Being watched somewhere else.' : ''))
    endNote = undefined
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
$('use').onclick = () => {
  using = true
  screenNote('')
  void followScreen()
}
$('stop-use').onclick = () => {
  using = false
  render()
}
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
