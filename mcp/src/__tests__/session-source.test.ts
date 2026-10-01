import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SaiApi } from '../api.js'
import { EventsPoller, STREAM_CLOSED_ERROR, StreamCollector } from '../session-source.js'
import type { ApprovalRequest, SseEvent } from '../types.js'

/**
 * A fake `/message` stream we can feed frame by frame from the test, so the
 * collector's "return on data-session, keep draining in the background"
 * behaviour is observable.
 */
function scriptedStream(): {
  response: Response
  push: (event: SseEvent | string) => void
  close: () => void
  error: (err: Error) => void
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  const response = new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
  return {
    response,
    push: (event) =>
      controller.enqueue(
        encoder.encode(typeof event === 'string' ? event : `data: ${JSON.stringify(event)}\n\n`),
      ),
    close: () => controller.close(),
    error: (err) => controller.error(err),
  }
}

const approval: ApprovalRequest = {
  approvalId: 'ap-1',
  title: 'Run',
  description: '',
  approvalType: 'exec',
  isLinkOnly: false,
}

/** Let the collector's background pump process what was pushed. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

describe('StreamCollector', () => {
  it('start resolves on data-session and the rest of the stream is buffered for wait', async () => {
    const stream = scriptedStream()
    const fetchImpl = vi.fn(async () => stream.response)
    const collector = new StreamCollector(new SaiApi('https://api.test', 'k', fetchImpl))

    const started = collector.start({ machineId: 'm1', message: 'ping' })
    stream.push({ type: 'start' })
    stream.push({ type: 'data-session', data: { sessionId: 's1' } })
    expect(await started).toEqual({ sessionId: 's1', machineId: 'm1', queued: false })

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.test/v1/agents/message')
    expect(JSON.parse(init.body as string)).toEqual({ machineId: 'm1', message: 'ping' })

    stream.push({ type: 'text-start', id: 'a' })
    stream.push({ type: 'text-delta', id: 'a', delta: 'PONG' })
    stream.push({ type: 'text-end', id: 'a' })
    stream.push(': keepalive\n\n')
    stream.push({ type: 'finish', finishReason: 'stop' })
    stream.push('data: [DONE]\n\n')
    stream.close()

    const result = await collector.wait('s1', { timeoutMs: 1_000 })
    expect(result.status).toBe('idle')
    expect(result.text).toBe('PONG')
    expect(result.events.map((e) => e.type)).toEqual([
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ])
    expect(result.cursor).toBe('4')
  })

  it('wait returns running with a fresh cursor on timeout, and only new events on the next call', async () => {
    const stream = scriptedStream()
    const collector = new StreamCollector(
      new SaiApi('https://api.test', 'k', async () => stream.response),
    )
    const started = collector.start({ machineId: 'm1', message: 'go' })
    stream.push({ type: 'data-session', data: { sessionId: 's2' } })
    await started
    stream.push({ type: 'reasoning-delta', id: 'r', delta: 'thinking' })
    await tick()

    const t0 = Date.now()
    const first = await collector.wait('s2', { timeoutMs: 30 })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25)
    expect(first.status).toBe('running')
    expect(first.events.map((e) => e.type)).toEqual(['reasoning-delta'])
    expect(first.cursor).toBe('1')

    stream.push({ type: 'data-progress', data: { text: 'Opening…', tool: 'exec' } })
    await tick()
    const second = await collector.wait('s2', { timeoutMs: 30, cursor: first.cursor })
    expect(second.events.map((e) => e.type)).toEqual(['data-progress'])
    expect(second.cursor).toBe('2')

    // A garbage cursor replays the whole turn rather than failing.
    const replay = await collector.wait('s2', { timeoutMs: 1, cursor: 'nonsense' })
    expect(replay.events).toHaveLength(2)
    stream.close()
  })

  it('wait unblocks the moment an approval arrives and reports it', async () => {
    const stream = scriptedStream()
    const collector = new StreamCollector(
      new SaiApi('https://api.test', 'k', async () => stream.response),
    )
    const started = collector.start({ machineId: 'm1', message: 'go' })
    stream.push({ type: 'data-session', data: { sessionId: 's3' } })
    await started

    const waiting = collector.wait('s3', { timeoutMs: 5_000 })
    setTimeout(() => stream.push({ type: 'data-approval-request', data: approval }), 10)
    const t0 = Date.now()
    const result = await waiting
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(result.status).toBe('needs_approval')
    expect(result.approval).toEqual(approval)
    expect(collector.findApproval('ap-1')).toEqual({ sessionId: 's3', approval })

    // Answering it locally flips back to running so the next wait blocks again.
    collector.noteApprovalResolved('ap-1')
    const after = await collector.wait('s3', { timeoutMs: 20, cursor: result.cursor })
    expect(after.status).toBe('running')
    expect(after.approval).toBeUndefined()

    // waitWhile: ['running','needs_approval'] holds through a known approval but
    // returns for a NEW approval id.
    stream.push({ type: 'data-approval-request', data: approval })
    await tick()
    const held = collector.wait('s3', {
      timeoutMs: 5_000,
      cursor: after.cursor,
      waitWhile: ['running', 'needs_approval'],
    })
    setTimeout(
      () =>
        stream.push({ type: 'data-approval-request', data: { ...approval, approvalId: 'ap-2' } }),
      10,
    )
    expect((await held).approval?.approvalId).toBe('ap-2')
    stream.close()
  })

  it('a stream that closes mid-task becomes an error status', async () => {
    const stream = scriptedStream()
    const collector = new StreamCollector(
      new SaiApi('https://api.test', 'k', async () => stream.response),
    )
    const started = collector.start({ machineId: 'm1', message: 'go' })
    stream.push({ type: 'data-session', data: { sessionId: 's4' } })
    await started
    stream.close()
    const result = await collector.wait('s4', { timeoutMs: 1_000 })
    expect(result.status).toBe('error')
    expect(result.error).toBe(STREAM_CLOSED_ERROR)
  })

  it('start rejects when the router refuses before a session exists', async () => {
    const stream = scriptedStream()
    const collector = new StreamCollector(
      new SaiApi('https://api.test', 'k', async () => stream.response),
    )
    const started = collector.start({ machineId: 'm1', message: 'go' })
    stream.push({ type: 'start' })
    stream.push({ type: 'error', errorText: 'Machine is offline.' })
    await expect(started).rejects.toThrow('Machine is offline.')
  })

  it('start rejects with the status text when the message was handled without delivery', async () => {
    const stream = scriptedStream()
    const collector = new StreamCollector(
      new SaiApi('https://api.test', 'k', async () => stream.response),
    )
    const started = collector.start({ machineId: 'm1', message: '/help' })
    stream.push({ type: 'data-status', data: { text: 'Message handled — nothing to stream.' } })
    stream.push({ type: 'finish', finishReason: 'stop' })
    await expect(started).rejects.toThrow('Message handled — nothing to stream.')
  })

  it('start surfaces a non-2xx as the server error', async () => {
    const collector = new StreamCollector(
      new SaiApi(
        'https://api.test',
        'k',
        async () => new Response(JSON.stringify({ error: 'Machine not found.' }), { status: 404 }),
      ),
    )
    await expect(collector.start({ machineId: 'nope', message: 'go' })).rejects.toThrow(
      'Failed to send the task (404): Machine not found.',
    )
  })

  it('wait on an unknown session explains the limitation', async () => {
    const collector = new StreamCollector(new SaiApi('https://api.test', 'k', vi.fn()))
    await expect(collector.wait('ghost', { timeoutMs: 1 })).rejects.toThrow(/Unknown session ghost/)
  })
})

describe('EventsPoller (SAI_EVENTS_API=1)', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
  afterEach(() => vi.useRealTimers())

  it('start posts wait:false and returns the 202 body', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ sessionId: 's1', machineId: 'm1', queued: true }), {
          status: 202,
        }),
    )
    const poller = new EventsPoller(new SaiApi('https://api.test', 'k', fetchImpl))
    expect(await poller.start({ machineId: 'm1', message: 'go' })).toEqual({
      sessionId: 's1',
      machineId: 'm1',
      queued: true,
    })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ machineId: 'm1', message: 'go', wait: false })
  })

  it('wait returns the task’s usage from the latest /events page', async () => {
    const usage = {
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 9000,
      cacheWriteTokens: 0,
      costUsd: 0.04,
      modelCalls: 3,
      byModel: {},
    }
    const pages = [
      { events: [], cursor: 'c1', status: 'running', text: '' },
      { events: [{ type: 'finish' }], cursor: 'c2', status: 'idle', text: 'ok', usage },
    ]
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(pages.shift()), { status: 200 }),
    )
    const poller = new EventsPoller(new SaiApi('https://api.test', 'k', fetchImpl))
    const r = await poller.wait('s1', { timeoutMs: 30_000 })
    expect(r).toMatchObject({ status: 'idle', usage })
  })

  it('wait polls /events with the cursor until status leaves running, first poll with wait=0', async () => {
    const pages = [
      {
        events: [{ type: 'reasoning-delta', id: 'r', delta: 'hm' }],
        cursor: 'c1',
        status: 'running',
        text: '',
      },
      {
        events: [{ type: 'text-delta', id: 't', delta: 'PONG' }],
        cursor: 'c2',
        status: 'running',
        text: 'PONG',
      },
      { events: [{ type: 'finish' }], cursor: 'c3', status: 'idle', text: 'PONG' },
    ]
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify(pages.shift()), { status: 200 })
    })
    const poller = new EventsPoller(new SaiApi('https://api.test', 'k', fetchImpl))
    const result = await poller.wait('s1', { timeoutMs: 90_000 })
    expect(result.status).toBe('idle')
    expect(result.text).toBe('PONG')
    expect(result.cursor).toBe('c3')
    expect(result.events.map((e) => e.type)).toEqual(['reasoning-delta', 'text-delta', 'finish'])
    const params = urls.map((u) => Object.fromEntries(new URL(u).searchParams))
    expect(params[0]).toEqual({ sessionId: 's1', wait: '0' })
    expect(params[1]).toEqual({ sessionId: 's1', wait: '60', since: 'c1' })
    expect(params[2]).toEqual({ sessionId: 's1', wait: '60', since: 'c2' })
  })

  it('caps the server wait at the remaining budget and returns running at the deadline', async () => {
    const waits: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      waits.push(new URL(url).searchParams.get('wait')!)
      // Pretend the server held for the requested time.
      vi.advanceTimersByTime(Number(new URL(url).searchParams.get('wait')) * 1000)
      return new Response(
        JSON.stringify({ events: [], cursor: 'c', status: 'running', text: '' }),
        { status: 200 },
      )
    })
    const poller = new EventsPoller(new SaiApi('https://api.test', 'k', fetchImpl))
    const result = await poller.wait('s1', { timeoutMs: 45_000, cursor: 'c0' })
    expect(result.status).toBe('running')
    expect(result.cursor).toBe('c')
    expect(waits[0]).toBe('0')
    expect(waits[1]).toBe('45')
    expect(waits).toHaveLength(2)
  })

  it('prefers the top-level approval from /events and remembers it across polls', async () => {
    const withUrl = { ...approval, approvalUrl: 'https://sai.simular.ai/approval/u/ap-1' }
    const pages = [
      {
        sessionId: 's1',
        events: [{ type: 'data-approval-request', data: approval }],
        cursor: 'c1',
        status: 'needs_approval',
        text: '',
        approval: withUrl,
      },
      { sessionId: 's1', events: [], cursor: 'c1', status: 'needs_approval', text: '' },
    ]
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(pages.shift()), { status: 200 }),
    )
    const poller = new EventsPoller(new SaiApi('https://api.test', 'k', fetchImpl))
    const first = await poller.wait('s1', { timeoutMs: 10_000 })
    expect(first.status).toBe('needs_approval')
    expect(first.approval).toEqual(withUrl)
    // Second call with the cursor: the card is not re-sent, but still reported.
    const second = await poller.wait('s1', { timeoutMs: 1, cursor: first.cursor })
    expect(second.approval).toEqual(withUrl)
    expect(poller.findApproval('ap-1')?.sessionId).toBe('s1')
  })

  it('paces re-polls while waiting through a known approval instead of spinning', async () => {
    const page = {
      sessionId: 's1',
      events: [],
      cursor: 'c1',
      status: 'needs_approval',
      text: '',
      approval,
    }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(page), { status: 200 }))
    const poller = new EventsPoller(new SaiApi('https://api.test', 'k', fetchImpl))
    await poller.wait('s1', { timeoutMs: 1 })
    // Deadline 12 s with 5 s pacing: first poll, then at most three more.
    const waiting = poller.wait('s1', {
      timeoutMs: 12_000,
      cursor: 'c1',
      waitWhile: ['running', 'needs_approval'],
    })
    await vi.advanceTimersByTimeAsync(13_000)
    await waiting
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(5)
  })
})
