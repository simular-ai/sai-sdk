import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  abortCurrentTask,
  errorDetail,
  listSessions,
  resolveSession,
  restartTarget,
  startNewSession,
} from '../sai/client.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>): { url: string; body: unknown } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit | undefined]
  return { url, body: init?.body ? JSON.parse(String(init.body)) : undefined }
}

// The server defaults `channel` to `api` for an API-key caller, and `sai` can run with a key.
// Every request that takes a channel names `cli`, so the CLI keeps its own conversation.
describe('the CLI names its own channel', () => {
  it('abort', async () => {
    const f = stubFetch(200, { ok: true, aborted: false })
    await abortCurrentTask('tok', 'm1')
    expect(lastCall(f).body).toEqual({ machineId: 'm1', channel: 'cli' })
  })

  it('session', async () => {
    const f = stubFetch(200, { machineId: 'm1' })
    await resolveSession('tok')
    expect(new URL(lastCall(f).url).searchParams.get('channel')).toBe('cli')
  })

  it('sessions', async () => {
    const f = stubFetch(200, { sessions: [] })
    await listSessions('tok', 'm1')
    const url = new URL(lastCall(f).url)
    expect(url.searchParams.get('machineId')).toBe('m1')
    expect(url.searchParams.get('channel')).toBe('cli')
  })

  it('restart', async () => {
    const f = stubFetch(200, { ok: true, action: 'agent' })
    await restartTarget('tok', 'm1', 'agent')
    expect(lastCall(f).body).toEqual({ machineId: 'm1', target: 'agent', channel: 'cli' })
  })

  it('new session', async () => {
    const f = stubFetch(200, { sessionId: 's1' })
    await startNewSession('tok', 'm1')
    expect(lastCall(f).body).toEqual({ machineId: 'm1', channel: 'cli' })
  })
})

describe('errorDetail', () => {
  it('prefers `message` (current servers send { error: code, message })', () => {
    expect(errorDetail({ error: 'not_found', message: 'Machine not found.' }, 'Not Found')).toBe(
      'Machine not found.',
    )
  })

  it('falls back to `error` (older servers put the text there)', () => {
    expect(errorDetail({ error: 'Machine not found.' }, 'Not Found')).toBe('Machine not found.')
  })

  it('falls back to the status text for a body with neither', () => {
    expect(errorDetail({}, 'Bad Gateway')).toBe('Bad Gateway')
    expect(errorDetail(null, 'Bad Gateway')).toBe('Bad Gateway')
  })

  it('shows the message, not the code, in a thrown error', async () => {
    stubFetch(404, { error: 'not_found', message: 'Session not found.' })
    await expect(abortCurrentTask('tok', 'm1')).rejects.toThrow(
      'Failed to abort task (404): Session not found.',
    )
  })

  it('points a /session 404 at the portal, not the desktop app', async () => {
    stubFetch(404, { error: 'no_machine', message: 'No machine found.' })
    const err = (await resolveSession('tok').catch((e: unknown) => e)) as Error
    expect(err.message).toContain('developer portal')
    expect(err.message).not.toContain('desktop app')
  })
})
