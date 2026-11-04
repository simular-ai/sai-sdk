import { describe, expect, it } from 'vitest'

import {
  ANOTHER_TASK_NOTE,
  UNKNOWN_TASK_NOTE,
  initialView,
  inputAllowed,
  useEnd,
  useStopsOnLoss,
  type TaskView,
} from '../view-model.js'

const at = (status: TaskView['status']): TaskView => ({ ...initialView, sessionId: 's1', status })

describe('task view input gating', () => {
  it('takes input while the task waits on the person, not while Sai works', () => {
    expect(inputAllowed(at('needs_approval'), false)).toBe(true)
    // decide() sets running before it calls sai_task_approve.
    expect(inputAllowed(at('running'), false)).toBe(false)
    expect(inputAllowed(at('starting'), false)).toBe(false)
  })

  it('after the task, takes input only while the person uses the computer', () => {
    for (const status of ['idle', 'error'] as const) {
      expect(inputAllowed(at(status), true)).toBe(true)
      // Done: input goes off at once, not when the screen closes.
      expect(inputAllowed(at(status), false)).toBe(false)
    }
  })

  it('stops using the computer once Sai starts another task on it', () => {
    expect(useEnd({ archived: true })).toBe(ANOTHER_TASK_NOTE)
    // A new turn on the same session (e.g. from another client).
    expect(useEnd({ status: 'running' })).toBe(ANOTHER_TASK_NOTE)
    expect(useEnd({ status: 'needs_approval' })).toBe(ANOTHER_TASK_NOTE)
    expect(useEnd({ expired: true })).toBe(UNKNOWN_TASK_NOTE)
  })

  it('keeps using the computer while the session stays done', () => {
    expect(useEnd({ status: 'idle' })).toBeUndefined()
    expect(useEnd({ status: 'error' })).toBeUndefined()
  })

  it('stops using it when the computer has no tunnel or is unreachable, after the task only', () => {
    expect(useStopsOnLoss(at('idle'), 'no_tunnel')).toBe(true)
    expect(useStopsOnLoss(at('idle'), 'unreachable')).toBe(true)
    expect(useStopsOnLoss(at('idle'), 'other')).toBe(false)
    // While the task runs, the view waits for the computer instead.
    expect(useStopsOnLoss(at('running'), 'no_tunnel')).toBe(false)
    expect(useStopsOnLoss(at('needs_approval'), 'unreachable')).toBe(false)
  })
})
