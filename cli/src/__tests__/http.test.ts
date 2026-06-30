import { describe, it, expect, vi, afterEach } from 'vitest'
import { apiFetch, toNetworkError } from '../http.js'

afterEach(() => {
  vi.restoreAllMocks()
})

/** Mimics Node's undici fetch rejection: TypeError('fetch failed') with the real
 *  reason on .cause. */
function fetchFailed(causeCode: string, causeMessage = '') {
  const err = new TypeError('fetch failed')
  ;(err as { cause?: unknown }).cause = { code: causeCode, message: causeMessage }
  return err
}

describe('toNetworkError', () => {
  it('explains a TLS cert hostname mismatch (the api.sai.simular.ai case)', () => {
    const e = toNetworkError(
      'https://api.sai.simular.ai/v1/agents/machines',
      fetchFailed('ERR_TLS_CERT_ALTNAME_INVALID'),
    )
    expect(e.message).toContain('api.sai.simular.ai')
    expect(e.message).toContain('TLS certificate')
    expect(e.message).not.toBe('fetch failed')
  })

  it('explains a DNS resolution failure', () => {
    const e = toNetworkError('https://nope.example.com/x', fetchFailed('ENOTFOUND'))
    expect(e.message).toContain('nope.example.com')
    expect(e.message).toMatch(/DNS/)
  })

  it('explains a refused connection', () => {
    const e = toNetworkError('https://localhost:9/x', fetchFailed('ECONNREFUSED'))
    expect(e.message).toContain('refused')
  })

  it('reports a timeout for AbortSignal.timeout rejections', () => {
    const timeout = new Error('The operation timed out.')
    timeout.name = 'TimeoutError'
    const e = toNetworkError('https://api.example.com/x', timeout)
    expect(e.message).toContain('timed out')
  })

  it('falls back to the underlying cause message for unknown codes', () => {
    const e = toNetworkError('https://api.example.com/x', fetchFailed('ESOMETHING', 'boom'))
    expect(e.message).toContain('boom')
  })

  it('mentions SAPI_API_URL so the user knows what to check', () => {
    const e = toNetworkError('https://api.example.com/x', fetchFailed('ECONNREFUSED'))
    expect(e.message).toContain('SAPI_API_URL')
  })
})

describe('apiFetch', () => {
  it('passes successful responses (incl. non-2xx) straight through', async () => {
    const res = new Response('{}', { status: 401 })
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res)
    const out = await apiFetch('https://api.example.com/x')
    expect(out.status).toBe(401)
  })

  it('translates connection-level rejections into actionable errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(fetchFailed('ERR_TLS_CERT_ALTNAME_INVALID'))
    await expect(apiFetch('https://api.sai.simular.ai/x')).rejects.toThrow(/TLS certificate/)
  })
})
