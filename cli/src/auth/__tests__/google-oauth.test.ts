import { describe, it, expect, vi, afterEach } from 'vitest'
import { get as httpGet } from 'http'
import * as cp from 'child_process'
import { browserOpenCommand } from '../google-oauth.js'

// Mock child_process so openBrowser() doesn't actually launch a browser.
// The mock captures the auth URL so tests can extract the redirect_uri and
// hit the local callback server directly.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execFile: vi.fn() }
})

/** Hits the local OAuth callback server using Node's http module (not globalThis.fetch,
 *  which may be mocked by the test for the exchange/firebase calls). */
function hitCallbackServer(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      res.resume() // drain — we only care that the server received the request
      res.on('end', resolve)
    }).on('error', reject)
  })
}

/** Starts performGoogleOAuth(), waits for the browser-open call, then extracts
 *  the loopback redirect_uri and state from the auth URL. Returns a helper to
 *  simulate Google redirecting the code directly to the local callback server. */
async function startOAuth() {
  const execFileMock = vi.mocked(cp.execFile)
  let capturedAuthUrl = ''
  execFileMock.mockImplementation(((_cmd: string, args: readonly string[]) => {
    // openBrowser passes the URL as the final arg on every platform
    // (macOS: ['<url>'], Linux: ['<url>'], Windows: ['/c','start','','<url>']).
    capturedAuthUrl = args[args.length - 1]
  }) as typeof cp.execFile)

  const { performGoogleOAuth } = await import('../google-oauth.js')
  const oauthPromise = performGoogleOAuth()

  // Wait until openBrowser() fires and we have the auth URL
  await vi.waitFor(() => expect(capturedAuthUrl).toBeTruthy(), { timeout: 3000 })

  const authUrl = new URL(capturedAuthUrl)
  const redirectUri = authUrl.searchParams.get('redirect_uri')!
  const state = authUrl.searchParams.get('state')!

  // Simulate Google redirecting to our loopback server with code/error
  async function triggerCallback(params: { code?: string; error?: string; state?: string }) {
    const cb = new URL(redirectUri)
    cb.searchParams.set('state', params.state ?? state)
    if (params.code) cb.searchParams.set('code', params.code)
    if (params.error) cb.searchParams.set('error', params.error)
    await hitCallbackServer(cb.toString())
  }

  return { oauthPromise, triggerCallback, redirectUri, state }
}

describe('performGoogleOAuth', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.mocked(cp.execFile).mockReset()
    vi.resetModules()
  })

  it('full happy-path: callback → token exchange → firebase sign-in returns OAuthResult', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        // Google token endpoint → Google ID token
        new Response(JSON.stringify({ id_token: 'google-id-token', access_token: 'access' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        // Firebase Identity Toolkit → Firebase ID token
        new Response(
          JSON.stringify({
            idToken: 'firebase-id-token',
            refreshToken: 'refresh-token',
            expiresIn: '3600',
            email: 'user@test.com',
            localId: 'uid-789',
          }),
          { status: 200 },
        ),
      )

    const { oauthPromise, triggerCallback } = await startOAuth()
    await triggerCallback({ code: 'auth-code-123' })
    const result = await oauthPromise

    expect(result.firebaseIdToken).toBe('firebase-id-token')
    expect(result.refreshToken).toBe('refresh-token')
    expect(result.idTokenExpiresIn).toBe(3600)
    expect(result.email).toBe('user@test.com')
    expect(result.userId).toBe('uid-789')
  })

  it('posts code, code_verifier, redirect_uri, and client_id to the Google token endpoint', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id_token: 'google-id-token' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            idToken: 'fb-token',
            refreshToken: 'r',
            expiresIn: '3600',
            email: 'x@x.com',
            localId: 'u1',
          }),
          { status: 200 },
        ),
      )

    const { oauthPromise, triggerCallback, redirectUri } = await startOAuth()
    await triggerCallback({ code: 'my-code' })
    await oauthPromise

    const [tokenUrl, tokenOpts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(tokenUrl).toBe('https://oauth2.googleapis.com/token')
    expect(tokenOpts.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
    })

    const body = new URLSearchParams(tokenOpts.body as string)
    expect(body.get('code')).toBe('my-code')
    expect(body.get('grant_type')).toBe('authorization_code')
    // redirect_uri in the exchange must be the same loopback URI used in the auth request
    expect(body.get('redirect_uri')).toBe(redirectUri)
    expect(body.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(body.get('code_verifier')).toBeTruthy()
    expect(body.get('client_secret')).toBeTruthy()
  })

  it('uses a loopback redirect_uri and random CSRF state in the auth URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 500 }),
    )
    const { oauthPromise, redirectUri, state } = await startOAuth()
    oauthPromise.catch(() => {}) // prevent unhandled rejection

    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(state).toMatch(/^[A-Za-z0-9_-]{10,}$/)
  })

  it('rejects with "OAuth error" when callback receives an error param', async () => {
    const { oauthPromise, triggerCallback } = await startOAuth()
    const assertion = expect(oauthPromise).rejects.toThrow('OAuth error: access_denied')
    await triggerCallback({ error: 'access_denied' })
    await assertion
  })

  it('rejects with state mismatch when the callback sends a wrong state', async () => {
    const { oauthPromise, triggerCallback } = await startOAuth()
    const assertion = expect(oauthPromise).rejects.toThrow('state mismatch')
    await triggerCallback({ code: 'valid-code', state: 'tampered-state' })
    await assertion
  })

  it('throws a descriptive error when the Google token endpoint returns 400', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Code was already redeemed.' }),
        { status: 400 },
      ),
    )

    const { oauthPromise, triggerCallback } = await startOAuth()
    const assertion = expect(oauthPromise).rejects.toThrow('Code exchange failed (400)')
    await triggerCallback({ code: 'bad-code' })
    await assertion
  })

  it('throws a descriptive error when Firebase Identity Toolkit returns 400', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id_token: 'google-id-token' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'INVALID_ID_TOKEN' } }), { status: 400 }),
      )

    const { oauthPromise, triggerCallback } = await startOAuth()
    const assertion = expect(oauthPromise).rejects.toThrow('Firebase sign-in failed (400)')
    await triggerCallback({ code: 'valid-code' })
    await assertion
  })
})

describe('browserOpenCommand', () => {
  // A realistic OAuth URL: multiple `&`-separated params, response_type second.
  const url =
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&response_type=code&scope=openid%20email&state=xyz'

  it('escapes & as ^& on Windows so cmd does not truncate the URL at the first &', () => {
    const [cmd, args] = browserOpenCommand(url, 'win32')
    expect(cmd).toBe('cmd')
    // ['/c', 'start', '<title>', '<url>']
    expect(args.slice(0, 3)).toEqual(['/c', 'start', ''])
    const passedUrl = args[3]
    // Every & must be part of a ^& sequence — i.e. none left unescaped for cmd.
    expect(passedUrl.match(/&/g)).toHaveLength(3)
    expect(passedUrl.match(/\^&/g)).toHaveLength(3)
    // Params after the first & (which cmd would otherwise drop) survive.
    expect(passedUrl).toContain('response_type=code')
    expect(passedUrl).toContain('scope=openid%20email')
    expect(passedUrl).toContain('state=xyz')
  })

  it('passes the URL unmodified on macOS and Linux', () => {
    expect(browserOpenCommand(url, 'darwin')).toEqual(['open', [url]])
    expect(browserOpenCommand(url, 'linux')).toEqual(['xdg-open', [url]])
  })
})
