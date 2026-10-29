import { describe, expect, it, vi } from 'vitest'
import type { SessionSource } from '../session-source.js'
import type { ApprovalRequest, WaitResult } from '../types.js'
import { notificationFor, watchSession, type ChannelNotification } from '../watcher.js'

const approval: ApprovalRequest = {
  approvalId: 'ap-1',
  title: 'Connect Gmail',
  description: 'Sai needs access to Gmail.',
  approvalType: 'service_connect',
  isLinkOnly: true,
  approvalUrl: 'https://sai.simular.ai/approval/u/ap-1',
}

describe('notificationFor', () => {
  it('uses identifier-safe meta keys only', () => {
    const n = notificationFor('s1', {
      status: 'needs_approval',
      events: [],
      text: 'so far',
      approval,
      cursor: '1',
    })
    for (const key of Object.keys(n.meta)) expect(key).toMatch(/^[A-Za-z0-9_]+$/)
    expect(n.meta).toEqual({
      session_id: 's1',
      event: 'needs_approval',
      approval_id: 'ap-1',
      approval_url: 'https://sai.simular.ai/approval/u/ap-1',
    })
    expect(n.content).toContain('Connect Gmail')
    expect(n.content).toContain('Open: https://sai.simular.ai/approval/u/ap-1')
    expect(n.content).toContain('so far')
  })

  it('idle carries the text; error carries the message', () => {
    expect(
      notificationFor('s1', { status: 'idle', events: [], text: 'PONG', cursor: '2' }),
    ).toEqual({
      content: 'PONG',
      meta: { session_id: 's1', event: 'idle' },
    })
    const e = notificationFor('s1', {
      status: 'error',
      events: [],
      text: '',
      cursor: '0',
      error: 'x',
    })
    expect(e.meta).toEqual({ session_id: 's1', event: 'error' })
    expect(e.content).toContain('x')
  })
})

describe('watchSession', () => {
  function sourceWith(results: WaitResult[]): { source: SessionSource; waits: unknown[] } {
    const waits: unknown[] = []
    const source: SessionSource = {
      start: vi.fn(),
      wait: vi.fn(async (_id, opts) => {
        waits.push(opts)
        const next = results.shift()
        if (!next) throw new Error('no more results')
        return next
      }),
      findApproval: () => undefined,
      noteApprovalResolved: vi.fn(),
      turnId: () => undefined,
    }
    return { source, waits }
  }

  it('announces each approval once, then the final idle, threading the cursor', async () => {
    const { source, waits } = sourceWith([
      { status: 'running', events: [], text: '', cursor: '1' },
      { status: 'needs_approval', events: [], text: '', approval, cursor: '2' },
      { status: 'needs_approval', events: [], text: '', approval, cursor: '2' },
      { status: 'idle', events: [], text: 'done', cursor: '5' },
    ])
    const sent: ChannelNotification[] = []
    await watchSession('s1', {
      source,
      notify: async (n) => {
        sent.push(n)
      },
      withUrl: async (a) => a,
      pollMs: 10,
    })
    expect(sent.map((n) => n.meta.event)).toEqual(['needs_approval', 'idle'])
    expect(sent[1]?.content).toBe('done')
    expect(waits).toEqual([
      { timeoutMs: 10, waitWhile: ['running'] },
      { timeoutMs: 10, cursor: '1', waitWhile: ['running'] },
      { timeoutMs: 10, cursor: '2', waitWhile: ['running', 'needs_approval'] },
      { timeoutMs: 10, cursor: '2', waitWhile: ['running', 'needs_approval'] },
    ])
  })

  it('fills the approval url before notifying and stops on error', async () => {
    const bare = { ...approval, approvalUrl: undefined }
    const { source } = sourceWith([
      { status: 'needs_approval', events: [], text: '', approval: bare, cursor: '1' },
      { status: 'error', events: [], text: '', cursor: '2', error: 'agent crashed' },
    ])
    const sent: ChannelNotification[] = []
    await watchSession('s1', {
      source,
      notify: async (n) => {
        sent.push(n)
      },
      withUrl: async (a) => ({ ...a, approvalUrl: 'https://u/ap-1' }),
      pollMs: 10,
    })
    expect(sent[0]?.meta.approval_url).toBe('https://u/ap-1')
    expect(sent[1]?.meta).toEqual({ session_id: 's1', event: 'error' })
    expect(sent[1]?.content).toContain('agent crashed')
  })

  it('reports a failed wait as an error notification and stops', async () => {
    const { source } = sourceWith([])
    const sent: ChannelNotification[] = []
    await watchSession('ghost', {
      source,
      notify: async (n) => {
        sent.push(n)
      },
      withUrl: async (a) => a,
      pollMs: 10,
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.meta.event).toBe('error')
  })
})
