/**
 * The smallest MCP Apps client that does the job (spec 2026-01-26): JSON-RPC
 * 2.0 over postMessage with the host window. `ui/initialize`, then the host
 * pushes the tool input/result; the view calls server tools with `tools/call`
 * and asks the host to open links. No dependency: the official client targets
 * MCP SDK v2, and this server is on v1.
 */

type Json = Record<string, unknown>

/** Links come from task events; only web URLs may be opened (no javascript:, data:, …). */
function isWebUrl(url: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}
interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export type DisplayMode = 'inline' | 'fullscreen' | 'pip'

export interface HostInfo {
  name?: string
  version?: string
}

export interface HostContext {
  theme?: 'light' | 'dark'
  displayMode?: DisplayMode
  availableDisplayModes?: DisplayMode[]
}

export interface ToolResult {
  content?: Array<{ type: string; text?: string }>
  structuredContent?: Json
  isError?: boolean
}

export class HostBridge {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  onToolInput?: (args: Json) => void
  onToolResult?: (result: ToolResult) => void
  onHostContext?: (context: HostContext) => void

  constructor(private readonly host: Window = window.parent) {
    window.addEventListener('message', (e) => this.receive(e))
  }

  private receive(e: MessageEvent): void {
    // Only the host that embeds this view may talk to it.
    if (e.source !== this.host) return
    const m = e.data as Json | null
    if (!m || m.jsonrpc !== '2.0') return
    if (typeof m.id === 'number' && ('result' in m || 'error' in m)) {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      const err = m.error as { message?: string } | undefined
      if (err) p.reject(new Error(err.message ?? 'Host error'))
      else p.resolve(m.result)
      return
    }
    const params = (m.params ?? {}) as Json
    if (m.method === 'ui/notifications/tool-input')
      this.onToolInput?.((params.arguments ?? {}) as Json)
    else if (m.method === 'ui/notifications/tool-result') this.onToolResult?.(params as ToolResult)
    else if (m.method === 'ui/notifications/host-context-changed')
      this.onHostContext?.(params as HostContext)
    // A request from the host (e.g. teardown): acknowledge it.
    if (m.id !== undefined && typeof m.method === 'string') {
      this.host.postMessage({ jsonrpc: '2.0', id: m.id, result: {} }, '*')
    }
  }

  private request(method: string, params: Json): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.host.postMessage({ jsonrpc: '2.0', id, method, params }, '*')
    })
  }

  private notify(method: string, params: Json): void {
    this.host.postMessage({ jsonrpc: '2.0', method, params }, '*')
  }

  async connect(version: string): Promise<{ hostInfo?: HostInfo; hostContext?: HostContext }> {
    const result = (await this.request('ui/initialize', {
      protocolVersion: '2026-01-26',
      appInfo: { name: 'Sai task', version },
      appCapabilities: { availableDisplayModes: ['inline', 'pip', 'fullscreen'] },
    })) as { hostInfo?: HostInfo; hostContext?: HostContext }
    this.notify('ui/notifications/initialized', {})
    return result
  }

  async callTool(name: string, args: Json): Promise<ToolResult> {
    return (await this.request('tools/call', { name, arguments: args })) as ToolResult
  }

  openLink(url: string): void {
    if (!isWebUrl(url)) return
    void this.request('ui/open-link', { url }).catch(() => {})
  }

  /** Ask for another display mode; resolves to the mode the host actually chose. */
  async requestDisplayMode(mode: DisplayMode): Promise<DisplayMode> {
    const r = (await this.request('ui/request-display-mode', { mode })) as { mode?: DisplayMode }
    return r.mode ?? mode
  }

  sizeChanged(height: number): void {
    this.notify('ui/notifications/size-changed', { width: document.body.scrollWidth, height })
  }
}

/**
 * The same surface for the page served by local-view.ts (no MCP Apps host):
 * tools go to `POST /tool` on the serving sai-mcp process, links open in a new
 * tab, and the task comes from the page URL instead of a tool-result push.
 */
export class LocalBridge {
  onToolInput?: (args: Json) => void
  onToolResult?: (result: ToolResult) => void
  onHostContext?: (context: HostContext) => void
  private readonly params = new URLSearchParams(location.search)
  private readonly token = this.params.get('t') ?? ''

  async connect(_version: string): Promise<{ hostInfo?: HostInfo; hostContext?: HostContext }> {
    const sessionId = this.params.get('s')
    const machineId = this.params.get('m')
    const taskId = this.params.get('k')
    if (sessionId) {
      queueMicrotask(() =>
        this.onToolResult?.({
          structuredContent: {
            session_id: sessionId,
            ...(machineId && { machine_id: machineId }),
            ...(taskId && { task_id: taskId }),
          },
        }),
      )
    }
    return {}
  }

  async callTool(name: string, args: Json): Promise<ToolResult> {
    const res = await fetch('/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sai-token': this.token },
      body: JSON.stringify({ name, arguments: args }),
    })
    if (!res.ok) return { isError: true, content: [{ type: 'text', text: `HTTP ${res.status}` }] }
    return (await res.json()) as ToolResult
  }

  openLink(url: string): void {
    if (isWebUrl(url)) window.open(url, '_blank', 'noopener,noreferrer')
  }

  async requestDisplayMode(_mode: DisplayMode): Promise<DisplayMode> {
    return 'inline'
  }

  sizeChanged(_height: number): void {
    // A browser tab sizes itself; there is no host to tell.
  }
}
