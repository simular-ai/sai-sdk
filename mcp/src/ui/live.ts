/**
 * The task view's live screen: the vendored Guacamole client (same copy as the
 * portal Playground) over the tunnel `sai_view_live` hands out. Input starts
 * off; the task view turns it on only while Sai isn't working (`setInput`).
 */
import './guacamole/all.js'
import { bindScreenInput } from './input.js'

/**
 * Why a stream dropped. `blocked`: the WebSocket never opened at all — the
 * host blocked it (Codex turns off an app's network unless it allows egress);
 * Guacamole reports that as 519 too, so it is told apart by whether the socket
 * opened, not by the code.
 */
export type DropKind = 'conflict' | 'unreachable' | 'blocked' | 'other'

function dropKind(code: number | undefined): DropKind {
  // Someone else has this session now.
  if (code === 0x0205 /* RESOURCE_CONFLICT */ || code === 0x0209 /* SESSION_CONFLICT */)
    return 'conflict'
  // The computer itself isn't there: asleep, waking, or being created.
  if (code === 0x0207 /* UPSTREAM_NOT_FOUND */ || code === 0x0208 /* UPSTREAM_UNAVAILABLE */)
    return 'unreachable'
  return 'other'
}

export interface LiveHandle {
  /** Forward the person's mouse and keyboard to the computer, or stop (releasing anything held). */
  setInput: (on: boolean) => void
  /**
   * Disconnect. With `keepFrame`, leave the last frame on screen as an image
   * and return it (a JPEG data URL); nothing if no frame ever arrived.
   */
  close: (keepFrame?: boolean) => string | undefined
}

export function connectLive(
  websocketUrl: string,
  container: HTMLElement,
  on: {
    connected: () => void
    lost: (reason: string, kind: DropKind) => void
  },
): LiveHandle {
  const G = window.Guacamole
  // Guacamole appends `?<connect data>` itself, so split the query off the URL.
  const [tunnelUrl, connectData = ''] = websocketUrl.split('?', 2) as [string, string?]
  const tunnel = new G.WebSocketTunnel(tunnelUrl)
  const client = new G.Client(tunnel)
  const display = client.getDisplay()
  const el = display.getElement()
  container.replaceChildren(el)
  const input = bindScreenInput(G, el, client)

  const fit = (): void => {
    const w = display.getWidth()
    if (w > 0) display.scale(container.clientWidth / w)
  }
  display.onresize = fit
  const observer = new ResizeObserver(fit)
  observer.observe(container)

  let closed = false
  let opened = false
  const lost = (reason: string, code?: number): void => {
    if (closed) return
    closed = true
    observer.disconnect()
    on.lost(reason, opened ? dropKind(code) : 'blocked')
  }
  tunnel.onerror = (s) => lost(s.message || `Tunnel error ${s.code}`, s.code)
  client.onerror = (s) => lost(s.message || `Client error ${s.code}`, s.code)
  client.onstatechange = (state) => {
    if (state === 3) on.connected()
    else if (state === 5) lost('Disconnected')
  }
  // The tunnel opens its WebSocket inside connect(): note whether it ever opens.
  const NativeWebSocket = window.WebSocket
  window.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols)
      this.addEventListener('open', () => (opened = true))
    }
  }
  try {
    client.connect(connectData)
  } finally {
    window.WebSocket = NativeWebSocket
  }

  return {
    setInput: (on) => {
      if (!closed) input.set(on)
    },
    close: (keepFrame = false) => {
      // Before anything else, while the client can still send the key-ups.
      input.dispose()
      let frame: string | undefined
      // A display that never got a frame flattens to an empty canvas: no image then.
      if (keepFrame && display.getWidth() > 0 && display.getHeight() > 0) {
        try {
          frame = display.flatten().toDataURL('image/jpeg', 0.7)
          showFrame(container, frame)
        } catch {
          frame = undefined
        }
      }
      if (!frame) container.replaceChildren()
      closed = true
      observer.disconnect()
      client.onstatechange = null
      client.onerror = null
      tunnel.onerror = null
      try {
        client.disconnect()
      } catch {
        // Already gone.
      }
      return frame
    },
  }
}

/** A still frame in the screen box (the last one a task showed). */
export function showFrame(container: HTMLElement, frame: string): void {
  const img = new Image()
  img.src = frame
  img.alt = 'The last frame of the computer screen'
  container.replaceChildren(img)
}
