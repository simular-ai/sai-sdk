/**
 * Mouse, touch and keyboard from the live screen to the computer, bound the
 * way the portal Playground binds them (sai-platform
 * `src/playground/guacamole/input.ts`). The keyboard listens on the screen
 * element only, never the document, so the host's chat box keeps its keys.
 *
 * Starts off. `set(false)` first lets go of any key or button still held, so
 * the computer is never left with a key down.
 */

export interface ScreenInput {
  set: (on: boolean) => void
  dispose: () => void
}

type MouseLike = {
  onmousedown: ((s: Guacamole.Mouse.State) => void) | null
  onmousemove: ((s: Guacamole.Mouse.State) => void) | null
  onmouseup: ((s: Guacamole.Mouse.State) => void) | null
}

export function bindScreenInput(
  G: typeof Guacamole,
  element: HTMLElement,
  client: Pick<Guacamole.Client, 'sendKeyEvent' | 'sendMouseState'>,
): ScreenInput {
  const keyboard = new G.Keyboard(element)
  const pointers: MouseLike[] = [new G.Mouse(element), new G.Mouse.Touchscreen(element)]
  let on = false
  let last: Guacamole.Mouse.State = { x: 0, y: 0 }

  const send = (state: Guacamole.Mouse.State): void => {
    if (!on) return
    last = { ...state }
    // `true`: Guacamole maps the scaled screen box back to the computer's pixels.
    client.sendMouseState(state, true)
  }
  for (const p of pointers) p.onmousedown = p.onmousemove = p.onmouseup = send
  keyboard.onkeydown = (key: number) => {
    if (!on) return true
    client.sendKeyEvent(1, key)
    return false
  }
  keyboard.onkeyup = (key: number) => {
    if (on) client.sendKeyEvent(0, key)
  }

  const release = (): void => {
    if (!on) return
    keyboard.reset()
    if (last.left || last.middle || last.right)
      client.sendMouseState({ x: last.x, y: last.y }, true)
    last = { x: last.x, y: last.y }
  }
  const focus = (): void => {
    if (on) element.focus({ preventScroll: true })
  }
  // Every key goes to the computer while the screen has focus, Tab included:
  // Ctrl+Alt+Esc hands the keyboard back to the page.
  const exit = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !event.ctrlKey || !event.altKey) return
    event.preventDefault()
    event.stopImmediatePropagation()
    release()
    element.blur()
  }
  const noMenu = (event: Event): void => {
    if (on) event.preventDefault()
  }
  element.addEventListener('keydown', exit, true)
  element.addEventListener('pointerdown', focus)
  element.addEventListener('blur', release)
  element.addEventListener('contextmenu', noMenu)
  window.addEventListener('blur', release)

  const set = (next: boolean): void => {
    if (next === on) return
    if (!next) release()
    on = next
    element.tabIndex = on ? 0 : -1
    element.style.cursor = on ? '' : 'default'
    element.style.touchAction = on ? 'none' : ''
    if (on) {
      element.setAttribute('role', 'application')
      element.setAttribute(
        'aria-label',
        'Remote computer. Click to type. Press Control Alt Escape to return to the page.',
      )
    } else {
      element.removeAttribute('role')
      element.removeAttribute('aria-label')
      element.blur()
    }
  }
  set(false)

  return {
    set,
    dispose: () => {
      set(false)
      keyboard.onkeydown = keyboard.onkeyup = null
      for (const p of pointers) p.onmousedown = p.onmousemove = p.onmouseup = null
      element.removeEventListener('keydown', exit, true)
      element.removeEventListener('pointerdown', focus)
      element.removeEventListener('blur', release)
      element.removeEventListener('contextmenu', noMenu)
      window.removeEventListener('blur', release)
    },
  }
}
