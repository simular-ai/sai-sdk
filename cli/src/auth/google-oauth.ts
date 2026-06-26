import { createServer } from 'http'
import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import { URL } from 'url'
import { generatePkce } from './pkce.js'
import { FIREBASE_WEB_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from '../config.js'

const GOOGLE_OAUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const FIREBASE_SIGNIN_WITH_IDP_URL =
  'https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp'
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

export interface OAuthResult {
  firebaseIdToken: string
  refreshToken: string
  idTokenExpiresIn: number
  email: string
  userId: string
}

function openBrowser(url: string): void {
  const args: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  execFile(args[0], args[1], (err) => {
    if (err) console.error('Could not open browser automatically:', err.message)
  })
}

/**
 * Starts an HTTP server on a random port (port 0) and returns the port and a
 * promise that resolves with the OAuth authorization code. Google redirects
 * directly to this loopback server (Desktop OAuth client — no relay needed).
 */
function startCallbackServer(
  redirectPath: string,
  expectedState: string,
): Promise<{ port: number; codePromise: Promise<string> }> {
  return new Promise((resolveSetup, rejectSetup) => {
    let resolveCode: (code: string) => void
    let rejectCode: (err: Error) => void
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res
      rejectCode = rej
    })

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`)
      if (url.pathname !== redirectPath) {
        res.writeHead(404)
        res.end()
        return
      }

      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      const state = url.searchParams.get('state')

      // Verify CSRF state — guards against cross-origin or replayed callbacks.
      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          '<html><body style="font-family:sans-serif;padding:2rem">' +
            '<h2>Sign-in failed</h2><p>Security check failed. Run <code>sapi login</code> again.</p>' +
            '</body></html>',
        )
        clearTimeout(timer)
        server.close()
        rejectCode!(new Error('OAuth state mismatch. Run `sapi login` again.'))
        return
      }

      clearTimeout(timer)
      server.close()

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          '<html><body style="font-family:sans-serif;padding:2rem">' +
            '<h2>Sign-in complete</h2><p>You can close this tab and return to the terminal.</p>' +
            '</body></html>',
        )
        resolveCode!(code)
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          '<html><body style="font-family:sans-serif;padding:2rem">' +
            '<h2>Sign-in cancelled</h2><p>You can close this tab and return to the terminal to try again.</p>' +
            '</body></html>',
        )
        rejectCode!(new Error(`OAuth error: ${error ?? 'unknown'}`))
      }
    })

    // Timeout: reject if no callback within OAUTH_CALLBACK_TIMEOUT_MS
    const timer = setTimeout(() => {
      server.close()
      rejectCode!(
        new Error(
          'Sign-in timed out (no browser callback received within 5 minutes). Run `sapi login` to try again.',
        ),
      )
    }, OAUTH_CALLBACK_TIMEOUT_MS)
    // Don't let the timer keep the process alive
    timer.unref()

    // Bind to port 0 — OS assigns a free port, no race between discovery + bind
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        clearTimeout(timer)
        server.close()
        rejectSetup(new Error('Could not determine callback port'))
        return
      }
      resolveSetup({ port: addr.port, codePromise })
    })

    server.on('error', (err) => {
      clearTimeout(timer)
      rejectSetup(err)
    })
  })
}

export async function performGoogleOAuth(): Promise<OAuthResult> {
  const redirectPath = '/callback'
  const state = randomBytes(16).toString('base64url')
  const { port, codePromise } = await startCallbackServer(redirectPath, state)

  // Desktop OAuth client: redirect_uri is the local loopback server, not a hosted page.
  // Must match a registered redirect_uri in the Google Desktop OAuth client.
  const redirectUri = `http://127.0.0.1:${port}/callback`
  const { codeVerifier, codeChallenge } = generatePkce()

  const authUrl = new URL(GOOGLE_OAUTH_URL)
  authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', 'openid email profile')
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('prompt', 'select_account')

  process.stdout.write('Opening browser for Google sign-in...\n')
  openBrowser(authUrl.toString())

  // Wait for Google to redirect to our local server
  const code = await codePromise

  // Exchange code directly with Google's token endpoint — Desktop clients use
  // PKCE only, no client_secret required.
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  })

  if (!tokenRes.ok) {
    const body = (await tokenRes.json().catch(() => ({}))) as {
      error?: string
      error_description?: string
    }
    throw new Error(
      `Code exchange failed (${tokenRes.status}): ${body.error_description ?? body.error ?? tokenRes.statusText}`,
    )
  }

  const { id_token: googleIdToken } = (await tokenRes.json()) as { id_token: string }

  // Exchange Google id_token for Firebase ID token via Identity Toolkit
  const firebaseRes = await fetch(`${FIREBASE_SIGNIN_WITH_IDP_URL}?key=${FIREBASE_WEB_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestUri: redirectUri,
      postBody: `id_token=${googleIdToken}&providerId=google.com`,
      returnSecureToken: true,
      returnIdpCredential: true,
    }),
  })

  if (!firebaseRes.ok) {
    const body = (await firebaseRes.json().catch(() => ({}))) as {
      error?: { message?: string }
    }
    throw new Error(
      `Firebase sign-in failed (${firebaseRes.status}): ${body.error?.message ?? firebaseRes.statusText}`,
    )
  }

  const firebaseData = (await firebaseRes.json()) as {
    idToken: string
    refreshToken: string
    expiresIn: string
    email: string
    localId: string
  }

  return {
    firebaseIdToken: firebaseData.idToken,
    refreshToken: firebaseData.refreshToken,
    idTokenExpiresIn: parseInt(firebaseData.expiresIn, 10),
    email: firebaseData.email,
    userId: firebaseData.localId,
  }
}
