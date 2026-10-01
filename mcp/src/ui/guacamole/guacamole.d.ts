// Type definitions for Guacamole JavaScript API
// Copied verbatim from app/src/renderer/src/guacamole.d.ts on 2026-09-29.
// Uses the global Guacamole object injected by all.min.js

declare namespace Guacamole {
  class WebSocketTunnel {
    constructor(url: string)
    onerror: ((status: Status) => void) | null
    onstatechange: ((state: number) => void) | null
    /** Whether the tunnel is currently connected */
    isConnected(): boolean
    connect(data?: string): void
    disconnect(): void
    /** The UUID of this tunnel, assigned by the server */
    uuid: string | null
    /** Overall connection timeout in ms (default: 15000) */
    receiveTimeout: number
    /** Time before marking connection as unstable in ms (default: 1500) */
    unstableThreshold: number
    /** Current tunnel state */
    state: number
  }

  class Client {
    constructor(tunnel: WebSocketTunnel)
    connect(data?: string): void
    disconnect(): void
    sendKeyEvent(pressed: number, keysym: number): void
    sendMouseState(state: Mouse.State, scale?: boolean): void
    getDisplay(): Display
    createClipboardStream(mimetype: string): OutputStream
    createFileStream(mimetype: string, filename: string): OutputStream
    onstatechange: ((state: number) => void) | null
    onname: ((name: string) => void) | null
    onerror: ((status: Status) => void) | null
    ondisconnect: (() => void) | null
    /** Fired when the current visible frame has been completely rendered */
    onsync: ((timestamp: number) => void) | null
    onclipboard: ((stream: InputStream, mimetype: string) => void) | null
    onfile: ((stream: InputStream, mimetype: string, filename: string) => void) | null
  }

  class Keyboard {
    constructor(element: Element | Document)
    onkeydown: ((keysym: number) => boolean | void) | null
    onkeyup: ((keysym: number) => void) | null
    listenTo(element: Element): void
    /** Releases every key this instance believes is down, firing onkeyup for each. */
    reset(): void
  }

  class Mouse {
    constructor(element: Element)
    onmousedown: ((state: Mouse.State) => void) | null
    onmousemove: ((state: Mouse.State) => void) | null
    onmouseup: ((state: Mouse.State) => void) | null
    /** Accumulated wheel px per emitted scroll click (default 53). */
    scrollThreshold: number
  }

  namespace Mouse {
    interface State {
      x: number
      y: number
      left?: boolean
      middle?: boolean
      right?: boolean
      up?: boolean
      down?: boolean
    }

    /** Touchpad-style touch input (drag to move cursor, tap to click) */
    class Touchpad {
      constructor(element: Element)
      onmousedown: ((state: State) => void) | null
      onmousemove: ((state: State) => void) | null
      onmouseup: ((state: State) => void) | null
    }

    /** Touchscreen-style touch input (tap = click at position, drag = click and drag) */
    class Touchscreen {
      constructor(element: Element)
      onmousedown: ((state: State) => void) | null
      onmousemove: ((state: State) => void) | null
      onmouseup: ((state: State) => void) | null
    }
  }

  class Display {
    getElement(): HTMLElement
    /** Layer rendering the software (server-echoed) mouse cursor. */
    getCursorLayer(): { getElement(): HTMLElement }
    getScale(): number
    scale(scale: number): void
    getWidth(): number
    getHeight(): number
    /** Composites every layer into one canvas: a snapshot of what is on screen. */
    flatten(): HTMLCanvasElement
    /** Fires when the remote display dimensions change (e.g. first frame). */
    onresize: ((width: number, height: number) => void) | null
  }

  class Status {
    code: number
    message: string
    isError(): boolean
    constructor(code: number, message?: string)
  }

  class InputStream {
    index: number
  }

  class OutputStream {
    index: number
  }

  class StringWriter {
    constructor(stream: OutputStream)
    sendText(text: string): void
    sendEnd(): void
  }

  class StringReader {
    constructor(stream: InputStream)
    ontext: ((text: string) => void) | null
    onend: (() => void) | null
  }

  class BlobWriter {
    constructor(stream: OutputStream)
    sendBlob(blob: Blob): void
    sendEnd(): void
    onack: ((status: Status) => void) | null
    oncomplete: ((blob: Blob) => void) | null
    onprogress: ((blob: Blob, position: number) => void) | null
    onerror: ((blob: Blob, position: number, error: Error) => void) | null
  }

  namespace Client {
    enum State {
      IDLE = 0,
      CONNECTING = 1,
      WAITING = 2,
      CONNECTED = 3,
      DISCONNECTING = 4,
      DISCONNECTED = 5,
    }
  }
}

interface Window {
  Guacamole: typeof Guacamole
}
