import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  resolveSession,
  streamMessage,
  sendApproval,
  fetchConciergeMessages,
  startConciergePoll,
} from '../client.js'
import type { SseEvent } from '../client.js'

afterEach(() => vi.restoreAllMocks())

const FAKE_CREDS = {
  idToken: 'bearer-token',
  refreshToken: 'refresh',
  idTokenExpiresAt: Date.now() + 3_600_000,
  sessionExpiresAt: Date.now() + 86_400_000,
  email: 'u@example.com',
  userId: 'uid-1',
  sessionTimeoutMs: 86_400_000,
}

// Builds a Response whose body streams the given SSE events.
function makeSseResponse(...events: object[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

// ─── resolveSession ──────────────────────────────────────────────────────────

describe('resolveSession', () => {
  it('returns { machineId, sessionId } on 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ machineId: 'm1', sessionId: 's1' }), { status: 200 }),
    )
    expect(await resolveSession(FAKE_CREDS.idToken)).toEqual({ machineId: 'm1', sessionId: 's1' })
  })

  it('sends Authorization: Bearer <idToken>', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ machineId: 'm1', sessionId: 's1' }), { status: 200 }),
      )
    await resolveSession(FAKE_CREDS.idToken)
    const [, opts] = spy.mock.calls[0] as [string, RequestInit]
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer bearer-token')
  })

  it('calls GET /v1/agents/session', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ machineId: 'm1', sessionId: 's1' }), { status: 200 }),
      )
    await resolveSession(FAKE_CREDS.idToken)
    const [url] = spy.mock.calls[0] as [string, ...unknown[]]
    expect(url).toContain('/v1/agents/session')
  })

  it('throws with "No machine found" hint on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'not found' }), { status: 404 }),
    )
    await expect(resolveSession(FAKE_CREDS.idToken)).rejects.toThrow('No machine found')
  })

  it('throws with the status code on other errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'server error' }), { status: 500 }),
    )
    await expect(resolveSession(FAKE_CREDS.idToken)).rejects.toThrow('500')
  })
})

// ─── streamMessage ───────────────────────────────────────────────────────────

describe('streamMessage', () => {
  it('calls POST /v1/cli/message with correct body and auth header', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeSseResponse({ type: 'finish', finishReason: 'stop' }))

    await streamMessage(FAKE_CREDS.idToken, 'machine-1', 'hello', 30_000, undefined, vi.fn())

    const [url, opts] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/v1/cli/message')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body as string)).toMatchObject({
      machineId: 'machine-1',
      message: 'hello',
    })
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer bearer-token')
  })

  it('fires onEvent for each SSE event in order', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeSseResponse(
        { type: 'data-status', data: { text: 'Working...' } },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Hello there' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: 'stop' },
      ),
    )

    const onEvent = vi.fn()
    await streamMessage(FAKE_CREDS.idToken, 'm1', 'hi', 30_000, undefined, onEvent)

    expect(onEvent).toHaveBeenCalledTimes(5)
    expect(onEvent.mock.calls[0][0]).toEqual({ type: 'data-status', data: { text: 'Working...' } })
    expect(onEvent.mock.calls[1][0]).toEqual({ type: 'text-start', id: 't1' })
    expect(onEvent.mock.calls[2][0]).toEqual({ type: 'text-delta', id: 't1', delta: 'Hello there' })
    expect(onEvent.mock.calls[3][0]).toEqual({ type: 'text-end', id: 't1' })
    expect(onEvent.mock.calls[4][0]).toEqual({ type: 'finish', finishReason: 'stop' })
  })

  it('stops processing after the "finish" event', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeSseResponse(
        { type: 'finish', finishReason: 'stop' },
        { type: 'text-delta', id: 't1', delta: 'should be ignored' }, // after finish
      ),
    )

    const onEvent = vi.fn()
    await streamMessage(FAKE_CREDS.idToken, 'm1', 'hi', 30_000, undefined, onEvent)

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent.mock.calls[0][0]).toEqual({ type: 'finish', finishReason: 'stop' })
  })

  it('stops processing after the "error" event', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeSseResponse({ type: 'error', errorText: 'Something went wrong' }),
    )

    const onEvent = vi.fn()
    await streamMessage(FAKE_CREDS.idToken, 'm1', 'hi', 30_000, undefined, onEvent)

    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent.mock.calls[0][0]).toEqual({ type: 'error', errorText: 'Something went wrong' })
  })

  it('throws on non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
    )
    await expect(
      streamMessage(FAKE_CREDS.idToken, 'm1', 'hi', 30_000, undefined, vi.fn()),
    ).rejects.toThrow('403')
  })

  it('throws "Connection closed unexpectedly" when stream ends without a terminal event', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      // Stream contains only a status event — no finish/error
      makeSseResponse({ type: 'data-status', data: { text: 'Working...' } }),
    )
    await expect(
      streamMessage(FAKE_CREDS.idToken, 'm1', 'hi', 30_000, undefined, vi.fn()),
    ).rejects.toThrow('Connection closed unexpectedly')
  })

  it('includes attachments in the request body when provided', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeSseResponse({ type: 'finish', finishReason: 'stop' }))

    const attachment = {
      path: 'user-files/u1/uploads/f.txt',
      name: 'f.txt',
      mime: 'text/plain',
      size: 42,
      fileId: 'file-1',
    }
    await streamMessage(FAKE_CREDS.idToken, 'm1', 'run this', 30_000, [attachment], vi.fn())

    const [, opts] = spy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(opts.body as string)
    expect(body.attachments).toHaveLength(1)
    expect(body.attachments[0]).toMatchObject(attachment)
  })

  it('omits attachments key when none are provided', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(makeSseResponse({ type: 'finish', finishReason: 'stop' }))

    await streamMessage(FAKE_CREDS.idToken, 'm1', 'hi', 30_000, undefined, vi.fn())

    const [, opts] = spy.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(opts.body as string)
    expect('attachments' in body).toBe(false)
  })

  it('ignores SSE keepalive comment lines (": keepalive")', async () => {
    const keepaliveBody =
      ': keepalive\n\n' +
      'data: {"type":"text-delta","id":"t1","delta":"hi"}\n\n' +
      ': keepalive\n\n' +
      'data: {"type":"finish","finishReason":"stop"}\n\n'

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(keepaliveBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    )

    const onEvent = vi.fn()
    await streamMessage(FAKE_CREDS.idToken, 'm1', 'hi', 30_000, undefined, onEvent)

    // Only the data events should fire, not the keepalive lines
    const types = onEvent.mock.calls.map((c) => (c[0] as SseEvent).type)
    expect(types).toEqual(['text-delta', 'finish'])
  })
})

// ─── sendApproval ──────────────────────────────────────────────────────────────

describe('sendApproval', () => {
  it('POSTs to /v1/agents/approve with the response and no selections by default', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, status: 'approved' }), { status: 200 }),
      )
    await sendApproval(FAKE_CREDS.idToken, 'a1', 'yes')
    const [url, opts] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/v1/agents/approve')
    expect(JSON.parse(opts.body as string)).toEqual({ approvalId: 'a1', response: 'yes' })
  })

  it('includes selections (a choice pick) when provided', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, status: 'approved' }), { status: 200 }),
      )
    await sendApproval(FAKE_CREDS.idToken, 'c1', 'yes', [['plan_pro']])
    const [, opts] = spy.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(opts.body as string)).toEqual({
      approvalId: 'c1',
      response: 'yes',
      selections: [['plan_pro']],
    })
  })

  it('throws with the status code on failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'gone' }), { status: 409 }),
    )
    await expect(sendApproval(FAKE_CREDS.idToken, 'a1', 'yes')).rejects.toThrow('409')
  })
})

// ─── concierge side track ─────────────────────────────────────────────────────

function conciergePage(
  messages: Array<{ id: string; role: string; content: string; timestamp: number }>,
  serverNowMs: number,
): Response {
  return new Response(JSON.stringify({ sessionId: 's1', serverNowMs, messages }), { status: 200 })
}

/** Query params of the nth fetch call. */
function queryOf(spy: ReturnType<typeof vi.spyOn>, n: number): URLSearchParams {
  const [url] = spy.mock.calls[n] as [string, ...unknown[]]
  return new URL(url).searchParams
}

describe('fetchConciergeMessages', () => {
  it('applies its own 10s timeout even when the caller passes a signal', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(conciergePage([], 100))
    const ac = new AbortController()

    await fetchConciergeMessages(FAKE_CREDS.idToken, 'm1', 0, { signal: ac.signal })

    // The combined signal is neither the caller's nor unset: a poll the server
    // never answers has to abort on its own, or `inFlight` wedges forever.
    const [, opts] = spy.mock.calls[0] as [string, RequestInit]
    expect(opts.signal).toBeInstanceOf(AbortSignal)
    expect(opts.signal).not.toBe(ac.signal)
    // Aborting the caller's signal still aborts the combined one.
    ac.abort()
    expect(opts.signal!.aborted).toBe(true)
  })

  it('marks a client-clock cursor with seed=1 and forwards the limit', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(conciergePage([], 100))

    await fetchConciergeMessages(FAKE_CREDS.idToken, 'm1', 42, { limit: 20, seed: true })

    const params = queryOf(spy, 0)
    expect(params.get('since')).toBe('42')
    expect(params.get('limit')).toBe('20')
    expect(params.get('seed')).toBe('1')
  })
})

describe('startConciergePoll', () => {
  /** Let an in-flight tick settle (fetch + the awaits around it). */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
  /** Run the poll for two ticks and return the fetch spy. */
  async function pollTwice(
    page: () => Response,
    sinceMs = 1_000,
    onConcierge = vi.fn(),
  ): Promise<ReturnType<typeof vi.spyOn>> {
    vi.useFakeTimers()
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => page())
    const stop = startConciergePoll({
      authToken: FAKE_CREDS.idToken,
      machineId: 'm1',
      sinceMs,
      onConcierge,
    })
    await settle()
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    stop()
    vi.useRealTimers()
    return spy as ReturnType<typeof vi.spyOn>
  }

  it('seeds only the first poll, then polls on the server-derived cursor', async () => {
    const spy = await pollTwice(() => conciergePage([], 5_000))

    expect(queryOf(spy, 0).get('seed')).toBe('1')
    expect(queryOf(spy, 0).get('since')).toBe('1000')
    // Cursor adopted from the server's clock, and no longer a seed.
    expect(queryOf(spy, 1).get('since')).toBe('5000')
    expect(queryOf(spy, 1).get('seed')).toBeNull()
  })

  it('does not jump the cursor past a full (truncated) page', async () => {
    // A full page means the server capped it. Advancing to server-now here
    // would skip whatever was cut off, for good — `seen` only dedupes what
    // actually came back.
    const full = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      role: 'concierge',
      content: `line ${i}`,
      timestamp: 1_100 + i,
    }))
    const spy = await pollTwice(() => conciergePage(full, 9_000))

    // The newest message returned (1119), not the server clock (9000).
    expect(queryOf(spy, 1).get('since')).toBe('1119')
  })

  it('prints only concierge-role messages, once each', async () => {
    const onConcierge = vi.fn()
    await pollTwice(
      () =>
        conciergePage(
          [
            { id: 'a', role: 'concierge', content: 'heads up', timestamp: 1_100 },
            { id: 'b', role: 'user', content: 'my message', timestamp: 1_101 },
            { id: 'c', role: 'concierge', content: '   ', timestamp: 1_102 },
          ],
          2_000,
        ),
      1_000,
      onConcierge,
    )

    // The second tick re-reads the same window; `seen` keeps it to one print.
    expect(onConcierge).toHaveBeenCalledTimes(1)
    expect(onConcierge).toHaveBeenCalledWith('heads up')
  })
})
