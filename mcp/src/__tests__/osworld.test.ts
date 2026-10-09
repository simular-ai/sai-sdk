import { describe, expect, it, vi } from 'vitest'
import { SaiApi } from '../api.js'
import { readConfig } from '../config.js'
import { attemptView, osworldToolDescriptions, startAndWait } from '../osworld.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const ATTEMPT = {
  attemptId: 'att_aaaaaaaaaaaaaaaaaaaaaaaa',
  taskId: '004',
  state: 'ready' as const,
  machineId: 'm-osworld-1',
  instruction: 'Sort the spreadsheet by date.',
  hasUser: true,
  score: null,
}

describe('osworld tools', () => {
  it('are off unless SAI_OSWORLD is set, and SAI_OSWORLD brings the session tools', () => {
    expect(readConfig({ SAI_API_KEY: 'k' })).toMatchObject({ osworld: false, sessions: false })
    expect(readConfig({ SAI_API_KEY: 'k', SAI_OSWORLD: '1' })).toMatchObject({
      osworld: true,
      sessions: true,
    })
  })

  it('point the agent at a session on the returned machine, and away from task assets', () => {
    expect(osworldToolDescriptions.osworld_start).toContain('sai_session_open')
    expect(osworldToolDescriptions.osworld_start).toMatch(/do not look for the task’s files/)
  })

  it('offer abandon as the way to restart a task', () => {
    expect(osworldToolDescriptions.osworld_abandon).toMatch(/without grading/)
    expect(osworldToolDescriptions.osworld_start).toMatch(/submit or abandon/)
  })

  it('show the attempt in snake_case', () => {
    expect(attemptView({ ...ATTEMPT, state: 'scored', score: 0.8 })).toEqual({
      attempt_id: ATTEMPT.attemptId,
      task_id: '004',
      state: 'scored',
      machine_id: 'm-osworld-1',
      instruction: 'Sort the spreadsheet by date.',
      has_user: true,
      score: 0.8,
    })
  })

  it('call the attempts routes with the key', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith('/ask_user') ? jsonResponse({ answer: 'Q3' }) : jsonResponse(ATTEMPT),
    )
    const api = new SaiApi('https://api.test', 'sapi_k', fetchImpl)

    await api.osworldStart('004')
    await api.osworldAskUser(ATTEMPT.attemptId, 'Which sheet?')
    await api.osworldGet(ATTEMPT.attemptId)
    await api.osworldEvaluate(ATTEMPT.attemptId, 'fail')
    await api.osworldAbandon(ATTEMPT.attemptId)

    const calls = fetchImpl.mock.calls.map(([url, init]) => ({
      url,
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: (init?.headers as Record<string, string>).Authorization,
    }))
    expect(calls).toEqual([
      {
        url: 'https://api.test/v1/benchmarks/osworld/attempts',
        method: 'POST',
        body: { taskId: '004' },
        auth: 'Bearer sapi_k',
      },
      {
        url: `https://api.test/v1/benchmarks/osworld/attempts/${ATTEMPT.attemptId}/ask_user`,
        method: 'POST',
        body: { question: 'Which sheet?' },
        auth: 'Bearer sapi_k',
      },
      {
        url: `https://api.test/v1/benchmarks/osworld/attempts/${ATTEMPT.attemptId}`,
        method: undefined,
        body: undefined,
        auth: 'Bearer sapi_k',
      },
      {
        url: `https://api.test/v1/benchmarks/osworld/attempts/${ATTEMPT.attemptId}/evaluate`,
        method: 'POST',
        body: { outcome: 'fail' },
        auth: 'Bearer sapi_k',
      },
      {
        url: `https://api.test/v1/benchmarks/osworld/attempts/${ATTEMPT.attemptId}/abandon`,
        method: 'POST',
        body: undefined,
        auth: 'Bearer sapi_k',
      },
    ])
  })

  it('wait for a starting attempt to be ready, polling it', async () => {
    let t = 0
    const states = ['starting', 'starting', 'ready'] as const
    const api = {
      osworldStart: vi.fn(async () => ({
        ...ATTEMPT,
        state: 'starting' as const,
        machineId: null,
      })),
      osworldGet: vi.fn(async () => ({
        ...ATTEMPT,
        state: states[api.osworldGet.mock.calls.length] ?? 'ready',
      })),
    }
    const sleep = vi.fn(async (ms: number) => void (t += ms))
    const ready = await startAndWait(api, '004', { now: () => t, sleep })
    expect(ready).toMatchObject({ state: 'ready', machineId: 'm-osworld-1' })
    expect(api.osworldGet).toHaveBeenCalledTimes(2)
    expect(api.osworldGet).toHaveBeenCalledWith(ATTEMPT.attemptId)
  })

  it('return a failed setup with its reason, and give up on one that never leaves starting', async () => {
    const clock = { now: () => 0, sleep: async () => {} }
    const failed = await startAndWait(
      {
        osworldStart: async () => ({ ...ATTEMPT, state: 'starting' as const }),
        osworldGet: async () => ({ ...ATTEMPT, state: 'failed' as const, reason: 'setup_failed' }),
      },
      '004',
      clock,
    )
    expect(attemptView(failed)).toMatchObject({ state: 'failed', reason: 'setup_failed' })

    let t = 0
    await expect(
      startAndWait(
        {
          osworldStart: async () => ({ ...ATTEMPT, state: 'starting' as const }),
          osworldGet: async () => ({ ...ATTEMPT, state: 'starting' as const }),
        },
        '004',
        { now: () => t, sleep: async (ms) => void (t += ms) },
      ),
    ).rejects.toThrow(/still starting/)
  })

  it('surface a limit refusal as an error the agent can read', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'attempt_limit', message: 'Up to 1 open attempt at a time.' }, 409),
    )
    const api = new SaiApi('https://api.test', 'sapi_k', fetchImpl)
    await expect(api.osworldStart('020')).rejects.toThrow(/Starting the OSWorld task failed/)
  })
})
