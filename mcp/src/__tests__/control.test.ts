import { describe, expect, it, vi } from 'vitest'
import { SaiApi } from '../api.js'
import { readConfig } from '../config.js'
import { execToolResult, SIMULANG_REFERENCE } from '../control.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('control tools', () => {
  it('are off unless SAI_CONTROL is set', () => {
    expect(readConfig({ SAI_API_KEY: 'k' }).control).toBe(false)
    expect(readConfig({ SAI_API_KEY: 'k', SAI_CONTROL: '1' }).control).toBe(true)
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

  it('calls the control API on the machine, with the key', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ machineId: 'm1', expiresAfterIdleSec: 600 }),
    )
    const api = new SaiApi('https://api.test', 'sapi_k', fetchImpl)
    await api.controlOpen('m1')
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://api.test/v1/machines/m1/control')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sapi_k')

    fetchImpl.mockResolvedValueOnce(
      jsonResponse({ logs: [], observations: {}, variables: [], durationMs: 1 }),
    )
    await api.controlExec('m1', '1 + 1', 5_000)
    const [execUrl, execInit] = fetchImpl.mock.calls[1]!
    expect(execUrl).toBe('https://api.test/v1/machines/m1/control/exec')
    expect(JSON.parse(String(execInit?.body))).toEqual({ code: '1 + 1', timeoutMs: 5_000 })

    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await api.controlClose('m1')
    const [closeUrl, closeInit] = fetchImpl.mock.calls[2]!
    expect(closeUrl).toBe('https://api.test/v1/machines/m1/control')
    expect(closeInit?.method).toBe('DELETE')
  })

  it('the reference names what direct control cannot do', () => {
    expect(SIMULANG_REFERENCE).toContain('Not available in direct control')
    expect(SIMULANG_REFERENCE).toContain('machine.browser.newtab')
  })
})
