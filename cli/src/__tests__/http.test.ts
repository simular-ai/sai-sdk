import { readFileSync } from 'fs'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { apiFetch, toNetworkError } from '../http.js'
import { VERSION } from '../version.js'

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

describe('apiFetch version tag', () => {
  function headersOf(spy: ReturnType<typeof vi.spyOn>): Record<string, string> {
    return (spy.mock.calls[0][1] as RequestInit | undefined)?.headers as Record<string, string>
  }

  it('sends no x-sai-version when SAI_VERSION_TAG is unset', async () => {
    vi.stubEnv('SAI_VERSION_TAG', '')
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}'))
    await apiFetch('https://api.example.com/x', { headers: { Authorization: 'Bearer t' } })
    expect(headersOf(spy)).not.toHaveProperty('x-sai-version')
  })

  it('routes to a tagged deployment when SAI_VERSION_TAG is set', async () => {
    vi.stubEnv('SAI_VERSION_TAG', 'fix-1668-cross-tenant-session-1669')
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}'))
    await apiFetch('https://api.example.com/x')
    expect(headersOf(spy)['x-sai-version']).toBe('fix-1668-cross-tenant-session-1669')
  })

  it('keeps the caller\u2019s own headers — the tag is additive, not a replacement', async () => {
    vi.stubEnv('SAI_VERSION_TAG', 'my-tag')
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}'))
    await apiFetch('https://api.example.com/x', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    })
    expect(headersOf(spy)).toMatchObject({
      Authorization: 'Bearer t',
      'Content-Type': 'application/json',
      'x-sai-version': 'my-tag',
    })
    expect((spy.mock.calls[0][1] as RequestInit).method).toBe('POST')
  })
})

describe('apiFetch User-Agent', () => {
  function headersOf(spy: ReturnType<typeof vi.spyOn>): Record<string, string> {
    return (spy.mock.calls[0][1] as RequestInit | undefined)?.headers as Record<string, string>
  }

  it('identifies the CLI as sai-cli/<package version>', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}'))
    await apiFetch('https://api.example.com/x')
    expect(headersOf(spy)['User-Agent']).toBe(`sai-cli/${VERSION}`)
  })

  it('sends it alongside the caller headers and the version tag', async () => {
    vi.stubEnv('SAI_VERSION_TAG', 'my-tag')
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}'))
    await apiFetch('https://api.example.com/x', { headers: { Authorization: 'Bearer t' } })
    expect(headersOf(spy)).toEqual({
      'User-Agent': `sai-cli/${VERSION}`,
      Authorization: 'Bearer t',
      'x-sai-version': 'my-tag',
    })
  })

  it('reports the version in package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    ) as { version: string }
    expect(VERSION).toBe(pkg.version)
  })
})
