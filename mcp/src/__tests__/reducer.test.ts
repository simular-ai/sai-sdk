import { describe, expect, it } from 'vitest'
import {
  applyEvent,
  decodeCursor,
  encodeCursor,
  initialState,
  markApprovalResolved,
} from '../reducer.js'
import type { ApprovalRequest, SseEvent } from '../types.js'

const approval: ApprovalRequest = {
  approvalId: 'ap-1',
  title: 'Run command',
  description: 'ls',
  approvalType: 'exec',
  isLinkOnly: false,
  command: 'ls',
}

function fold(events: SseEvent[]) {
  const state = initialState()
  for (const e of events) applyEvent(state, e)
  return state
}

describe('event → status reducer', () => {
  it('starts running with no text', () => {
    expect(initialState()).toEqual({ status: 'running', events: [], text: '' })
  })

  it('accumulates text-delta into text and stays running', () => {
    const s = fold([
      { type: 'text-start', id: 'm1' },
      { type: 'text-delta', id: 'm1', delta: 'Hel' },
      { type: 'text-delta', id: 'm1', delta: 'lo' },
      { type: 'text-end', id: 'm1' },
    ])
    expect(s.status).toBe('running')
    expect(s.text).toBe('Hello')
    expect(s.events).toHaveLength(4)
  })

  it('data-approval-request → needs_approval with the card', () => {
    const s = fold([{ type: 'data-approval-request', data: approval }])
    expect(s.status).toBe('needs_approval')
    expect(s.approval).toEqual(approval)
  })

  it('keeps the latest of two approvals', () => {
    const second = { ...approval, approvalId: 'ap-2' }
    const s = fold([
      { type: 'data-approval-request', data: approval },
      { type: 'data-approval-request', data: second },
    ])
    expect(s.approval?.approvalId).toBe('ap-2')
  })

  it('activity after an approval means the agent resumed → running', () => {
    const s = fold([
      { type: 'data-approval-request', data: approval },
      { type: 'tool-input-start', toolCallId: 't1', toolName: 'exec' },
    ])
    expect(s.status).toBe('running')
    expect(s.approval).toBeUndefined()
  })

  it('data-status does not change status', () => {
    const s = fold([
      { type: 'data-approval-request', data: approval },
      { type: 'data-status', data: { text: 'stalled', kind: 'stalled' } },
    ])
    expect(s.status).toBe('needs_approval')
  })

  it('finish → idle, text preserved', () => {
    const s = fold([
      { type: 'text-delta', id: 'm1', delta: 'PONG' },
      { type: 'finish', finishReason: 'stop' },
    ])
    expect(s.status).toBe('idle')
    expect(s.text).toBe('PONG')
    expect(s.approval).toBeUndefined()
  })

  it('error → error with the message', () => {
    const s = fold([{ type: 'error', errorText: 'boom' }])
    expect(s.status).toBe('error')
    expect(s.error).toBe('boom')
  })

  it('markApprovalResolved flips only the matching pending approval back to running', () => {
    const s = fold([{ type: 'data-approval-request', data: approval }])
    markApprovalResolved(s, 'other')
    expect(s.status).toBe('needs_approval')
    markApprovalResolved(s, 'ap-1')
    expect(s.status).toBe('running')
    expect(s.approval).toBeUndefined()
  })
})

describe('cursor codec', () => {
  it('round-trips and clamps', () => {
    expect(decodeCursor(encodeCursor(3), 10)).toBe(3)
    expect(decodeCursor('99', 5)).toBe(5)
    expect(decodeCursor(undefined, 5)).toBe(0)
    expect(decodeCursor('garbage', 5)).toBe(0)
    expect(decodeCursor('-2', 5)).toBe(0)
  })
})
