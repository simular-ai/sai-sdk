import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, SaiApi } from '../api.js'
import type { SessionSource } from '../session-source.js'
import { SaiTools } from '../tools.js'

function fixture() {
  const turn = vi.fn().mockResolvedValue({ status: 'finalizing' })
  const learn = vi.fn().mockResolvedValue({ status: 'succeeded', code: 'code' })
  const turnId = vi.fn(() => 'turn_a')
  const tools = new SaiTools({
    api: { turn, learn } as unknown as SaiApi,
    source: { turnId } as unknown as SessionSource,
    push: false,
    userId: async () => undefined,
  })
  return { tools, turn, learn, turnId }
}

afterEach(() => vi.useRealTimers())

describe('learn finalization', () => {
  it('waits through delayed finalization and shares one conversion across tool calls', async () => {
    vi.useFakeTimers()
    const { tools, turn, learn } = fixture()
    const first = tools.learn({ session_id: 's' }, 10)
    await vi.advanceTimersByTimeAsync(10)
    expect(await first).toMatchObject({
      status: 'running',
      message: expect.stringMatching(/finalization/),
    })
    expect(learn).not.toHaveBeenCalled()
    const next = tools.learn({ session_id: 's' })
    const concurrent = tools.learn({ session_id: 's' })
    turn.mockResolvedValue({ status: 'succeeded' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await next).toEqual({ status: 'succeeded', code: 'code' })
    expect(await concurrent).toEqual(await next)
    expect(learn).toHaveBeenCalledTimes(1)
    expect(learn).toHaveBeenCalledWith({ turns: ['turn_a'] })
  })

  it('reads the turn endpoint before posting learn, with auth and a bounded request', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'finalizing' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'succeeded' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'succeeded', code: 'code' })))
    const tools = new SaiTools({
      api: new SaiApi('https://api.test', 'key', fetchImpl),
      source: { turnId: () => 'turn/a' } as unknown as SessionSource,
      push: true,
      userId: async () => undefined,
    })
    const result = tools.learn({ session_id: 's' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toMatchObject({ code: 'code' })
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://api.test/v1/agents/turns/turn%2Fa',
      'https://api.test/v1/agents/turns/turn%2Fa',
      'https://api.test/v1/agents/learn',
    ])
    const init = fetchImpl.mock.calls[0]![1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.headers).toMatchObject({ Authorization: 'Bearer key' })
    expect(JSON.parse(fetchImpl.mock.calls[2]![1].body)).toEqual({ turns: ['turn/a'] })
  })

  it('keeps the captured turn when the session starts another task', async () => {
    vi.useFakeTimers()
    const { tools, turn, learn, turnId } = fixture()
    const result = tools.learn({ session_id: 'reused' }, 5000)
    await vi.advanceTimersByTimeAsync(0)
    turnId.mockReturnValue('turn_b')
    turn.mockResolvedValue({ status: 'failed' })
    await vi.advanceTimersByTimeAsync(1000)
    await result
    expect(turn.mock.calls.map(([id]) => id)).toEqual(['turn_a', 'turn_a'])
    expect(learn).toHaveBeenCalledWith({ turns: ['turn_a'] })
  })

  it('expires one deadline across resumed calls and never submits learn', async () => {
    vi.useFakeTimers()
    const { tools, learn } = fixture()
    const first = tools.learn({ session_id: 's' }, 10)
    await vi.advanceTimersByTimeAsync(10)
    await first
    await vi.advanceTimersByTimeAsync(350_000)
    const resumed = tools.learn({ session_id: 's' })
    const rejected = expect(resumed).rejects.toThrow(/finalization.*timed out/i)
    await vi.advanceTimersByTimeAsync(10_000)
    await rejected
    expect(learn).not.toHaveBeenCalled()
  })

  it('delivers a background deadline failure to the next caller instead of restarting', async () => {
    vi.useFakeTimers()
    const { tools, turn, learn } = fixture()
    const first = tools.learn({ session_id: 's' }, 10)
    await vi.advanceTimersByTimeAsync(10)
    await first
    await vi.advanceTimersByTimeAsync(360_000)
    const reads = turn.mock.calls.length
    await expect(tools.learn({ session_id: 's' })).rejects.toThrow(/finalization.*timed out/i)
    expect(turn).toHaveBeenCalledTimes(reads)
    expect(learn).not.toHaveBeenCalled()
  })

  it.each(['running', 'needs_input', 'succeeded', 'failed'])(
    'preserves learn errors for %s',
    async (status) => {
      const { tools, turn, learn } = fixture()
      turn.mockResolvedValue({ status })
      const error = new ApiError(409, { error: 'trajectory_not_recorded' }, 'original error')
      learn.mockRejectedValue(error)
      await expect(tools.learn({ session_id: 's' })).rejects.toBe(error)
      expect(turn).toHaveBeenCalledTimes(1)
      expect(learn).toHaveBeenCalledTimes(1)
    },
  )

  it('preserves turn read errors without submitting or retrying', async () => {
    const { tools, turn, learn } = fixture()
    const error = new ApiError(404, { error: 'turn_not_found' }, 'missing')
    turn.mockRejectedValue(error)
    await expect(tools.learn({ session_id: 's' })).rejects.toBe(error)
    expect(turn).toHaveBeenCalledTimes(1)
    expect(learn).not.toHaveBeenCalled()
  })
})
