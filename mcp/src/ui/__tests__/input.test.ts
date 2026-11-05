import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { bindScreenInput } from '../input.js'

type State = Guacamole.Mouse.State
type Pointer = {
  onmousedown: ((s: State) => void) | null
  onmousemove: ((s: State) => void) | null
  onmouseup: ((s: State) => void) | null
}

/** Guacamole's input classes, reduced to the handlers the binding sets. */
function fakeGuacamole() {
  const made: { keyboard?: FakeKeyboard; pointers: Pointer[] } = { pointers: [] }
  class FakeKeyboard {
    onkeydown: ((k: number) => boolean | void) | null = null
    onkeyup: ((k: number) => void) | null = null
    down = new Set<number>()
    constructor() {
      made.keyboard = this
    }
    press(k: number): boolean | void {
      this.down.add(k)
      return this.onkeydown?.(k)
    }
    reset(): void {
      for (const k of this.down) this.onkeyup?.(k)
      this.down.clear()
    }
  }
  class FakePointer implements Pointer {
    onmousedown: Pointer['onmousedown'] = null
    onmousemove: Pointer['onmousemove'] = null
    onmouseup: Pointer['onmouseup'] = null
    constructor() {
      made.pointers.push(this)
    }
  }
  const Mouse = Object.assign(class extends FakePointer {}, {
    Touchscreen: class extends FakePointer {},
  })
  const G = { Keyboard: FakeKeyboard, Mouse } as unknown as typeof Guacamole
  return { G, made }
}

function fakeElement() {
  const el = new EventTarget() as EventTarget & Record<string, unknown>
  Object.assign(el, {
    tabIndex: -1,
    style: {} as Record<string, string>,
    attrs: new Map<string, string>(),
    focus: vi.fn(),
    blur: vi.fn(),
    setAttribute(k: string, v: string) {
      ;(el.attrs as Map<string, string>).set(k, v)
    },
    removeAttribute(k: string) {
      ;(el.attrs as Map<string, string>).delete(k)
    },
  })
  return el as unknown as HTMLElement & { attrs: Map<string, string> }
}

const newClient = () => ({
  sendKeyEvent: vi.fn<(pressed: number, keysym: number) => void>(),
  sendMouseState: vi.fn<(state: State, scale?: boolean) => void>(),
})
let client: ReturnType<typeof newClient>
beforeEach(() => {
  vi.stubGlobal('window', new EventTarget())
  client = newClient()
})
afterEach(() => vi.unstubAllGlobals())

describe('bindScreenInput', () => {
  it('sends nothing until input is turned on, and leaves the keys to the page', () => {
    const { G, made } = fakeGuacamole()
    const el = fakeElement()
    bindScreenInput(G, el, client)
    expect(made.keyboard!.press(65)).toBe(true)
    made.pointers[0]!.onmousedown!({ x: 1, y: 2, left: true })
    expect(client.sendKeyEvent).not.toHaveBeenCalled()
    expect(client.sendMouseState).not.toHaveBeenCalled()
    expect(el.tabIndex).toBe(-1)
  })

  it('forwards mouse, touch and keys once on, scaled to the computer', () => {
    const { G, made } = fakeGuacamole()
    const el = fakeElement()
    bindScreenInput(G, el, client).set(true)
    expect(el.tabIndex).toBe(0)
    expect(el.attrs.get('role')).toBe('application')
    made.pointers[0]!.onmousedown!({ x: 10, y: 20, left: true })
    made.pointers[1]!.onmousemove!({ x: 11, y: 21 })
    expect(client.sendMouseState).toHaveBeenNthCalledWith(1, { x: 10, y: 20, left: true }, true)
    expect(client.sendMouseState).toHaveBeenNthCalledWith(2, { x: 11, y: 21 }, true)
    expect(made.keyboard!.press(65)).toBe(false)
    expect(client.sendKeyEvent).toHaveBeenCalledWith(1, 65)
  })

  it('lets go of held keys and buttons when turned off, then stops sending', () => {
    const { G, made } = fakeGuacamole()
    const el = fakeElement()
    const input = bindScreenInput(G, el, client)
    input.set(true)
    made.keyboard!.press(0xffe3)
    made.pointers[0]!.onmousedown!({ x: 5, y: 6, left: true })
    client.sendKeyEvent.mockClear()
    client.sendMouseState.mockClear()
    input.set(false)
    expect(client.sendKeyEvent).toHaveBeenCalledWith(0, 0xffe3)
    expect(client.sendMouseState).toHaveBeenCalledWith({ x: 5, y: 6 }, true)
    expect(el.tabIndex).toBe(-1)
    expect(el.attrs.has('role')).toBe(false)
    client.sendKeyEvent.mockClear()
    made.keyboard!.press(66)
    expect(client.sendKeyEvent).not.toHaveBeenCalled()
  })

  it('releases held keys when the page loses focus', () => {
    const { G, made } = fakeGuacamole()
    bindScreenInput(G, fakeElement(), client).set(true)
    made.keyboard!.press(0xffe9)
    window.dispatchEvent(new Event('blur'))
    expect(client.sendKeyEvent).toHaveBeenLastCalledWith(0, 0xffe9)
  })

  it('gives the keyboard back on Control+Alt+Escape', () => {
    const { G, made } = fakeGuacamole()
    const el = fakeElement()
    bindScreenInput(G, el, client).set(true)
    made.keyboard!.press(0xffe3)
    const event = Object.assign(new Event('keydown', { cancelable: true }), {
      key: 'Escape',
      ctrlKey: true,
      altKey: true,
    })
    el.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(el.blur).toHaveBeenCalled()
    expect(client.sendKeyEvent).toHaveBeenLastCalledWith(0, 0xffe3)
  })
})
