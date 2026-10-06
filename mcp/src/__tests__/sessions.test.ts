import { describe, expect, it, vi } from 'vitest'
import { SaiApi } from '../api.js'
import { readConfig } from '../config.js'
import { execToolResult, SIMULANG_REFERENCE } from '../sessions.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('session tools', () => {
  it('are off unless SAI_SESSIONS is set', () => {
    expect(readConfig({ SAI_API_KEY: 'k' }).sessions).toBe(false)
    expect(readConfig({ SAI_API_KEY: 'k', SAI_SESSIONS: '1' }).sessions).toBe(true)
  })

  it('returns the screenshot as MCP image content, the rest as text', () => {
    const out = execToolResult({
      result: 2,
      logs: ['hi'],
      observations: { screenshot: { base64: '/9j/AAAA', mimeType: 'image/jpeg' } },
      variables: [{ name: 'x', type: 'number', preview: '1' }],
      durationMs: 7,
    })
    expect(out.content).toHaveLength(2)
    expect(out.content[1]).toEqual({ type: 'image', data: '/9j/AAAA', mimeType: 'image/jpeg' })
    const text = JSON.parse((out.content[0] as { text: string }).text)
    expect(text).toEqual({
      result: 2,
      logs: ['hi'],
      variables: [{ name: 'x', type: 'number', preview: '1' }],
      duration_ms: 7,
    })
    expect(JSON.stringify(text)).not.toContain('/9j/')
  })

  it('a block that threw is still a successful tool call carrying the error', () => {
    const out = execToolResult({
      logs: [],
      error: { kind: 'exception', message: 'boom' },
      observations: {},
      variables: [],
      durationMs: 1,
    })
    expect(out.isError).toBeUndefined()
    expect(out.content).toHaveLength(1)
    expect((out.content[0] as { text: string }).text).toContain('boom')
  })

  it('calls the sessions API with the key', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ sessionId: 'ses_1', machineId: 'm1', expiresAfterIdleSec: 600 }),
    )
    const api = new SaiApi('https://api.test', 'sapi_k', fetchImpl)
    await api.sessionOpen('m1')
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://api.test/v1/sessions')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ machineId: 'm1' })
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sapi_k')

    fetchImpl.mockResolvedValueOnce(
      jsonResponse({ logs: [], observations: {}, variables: [], durationMs: 1 }),
    )
    await api.sessionExec('ses_1', '1 + 1', 5_000)
    const [execUrl, execInit] = fetchImpl.mock.calls[1]!
    expect(execUrl).toBe('https://api.test/v1/sessions/ses_1/exec')
    expect(JSON.parse(String(execInit?.body))).toEqual({ code: '1 + 1', timeoutMs: 5_000 })
  })

  it('the reference names what a session cannot do', () => {
    expect(SIMULANG_REFERENCE).toContain('Not available in a session')
    expect(SIMULANG_REFERENCE).toContain('machine.browser.newtab')
  })
})
