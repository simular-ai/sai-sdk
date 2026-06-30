import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// This variable is captured by the mock factory via closure.
// Updated in beforeEach before vi.resetModules() forces the module to re-evaluate,
// so each test gets a fresh isolated directory for SAPI_DIR.
let HOME_DIR = ''

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => HOME_DIR }
})

const BASE_PARAMS = {
  firebaseIdToken: 'id-token-abc',
  refreshToken: 'refresh-token-xyz',
  idTokenExpiresIn: 3600,
  email: 'user@example.com',
  userId: 'uid-123',
}

describe('token-store', () => {
  let mod: typeof import('../token-store.js')

  beforeEach(async () => {
    HOME_DIR = mkdtempSync(join(tmpdir(), 'sapi-test-'))
    vi.resetModules()
    mod = await import('../token-store.js')
  })

  afterEach(() => {
    rmSync(HOME_DIR, { recursive: true, force: true })
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  // ─── saveCredentials ─────────────────────────────────────────────────────────

  it('saveCredentials writes a valid credentials.json', () => {
    const creds = mod.saveCredentials(BASE_PARAMS)

    const credPath = join(HOME_DIR, '.sapi', 'credentials.json')
    expect(existsSync(credPath)).toBe(true)

    const stored = JSON.parse(readFileSync(credPath, 'utf-8'))
    expect(stored.idToken).toBe('id-token-abc')
    expect(stored.email).toBe('user@example.com')
    expect(stored.userId).toBe('uid-123')
    expect(stored.sessionExpiresAt).toBeGreaterThan(Date.now())

    // Return value includes the refresh token in memory
    expect(creds.idToken).toBe('id-token-abc')
    expect(creds.refreshToken).toBe('refresh-token-xyz')
  })

  it('saveCredentials does not write refreshToken to credentials.json', () => {
    mod.saveCredentials(BASE_PARAMS)
    const credPath = join(HOME_DIR, '.sapi', 'credentials.json')
    const stored = JSON.parse(readFileSync(credPath, 'utf-8'))
    expect(stored.refreshToken).toBeUndefined()
  })

  // Windows has no POSIX permission bits — chmod(0o600) only toggles the
  // read-only flag and the mode reads back as 0o666, so this is POSIX-only.
  it.skipIf(process.platform === 'win32')('saveCredentials sets file permissions to 0o600', () => {
    mod.saveCredentials(BASE_PARAMS)
    const credPath = join(HOME_DIR, '.sapi', 'credentials.json')
    const mode = statSync(credPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  // ─── loadCredentials ─────────────────────────────────────────────────────────

  it('loadCredentials returns null when file does not exist', () => {
    expect(mod.loadCredentials()).toBeNull()
  })

  it('loadCredentials round-trips saved credentials including refreshToken', () => {
    mod.saveCredentials(BASE_PARAMS)
    const loaded = mod.loadCredentials()
    expect(loaded?.idToken).toBe('id-token-abc')
    expect(loaded?.email).toBe('user@example.com')
    expect(loaded?.userId).toBe('uid-123')
    expect(loaded?.refreshToken).toBe('refresh-token-xyz')
  })

  it('loadCredentials returns null when .rt is missing', () => {
    mod.saveCredentials(BASE_PARAMS) // creates credentials.json + .mk + .rt
    unlinkSync(join(HOME_DIR, '.sapi', '.rt')) // simulate .rt being deleted
    expect(mod.loadCredentials()).toBeNull()
  })

  // ─── clearCredentials ────────────────────────────────────────────────────────

  it('clearCredentials removes credentials.json and session.json', () => {
    mod.saveCredentials(BASE_PARAMS)
    mod.saveSession({ machineId: 'm1' })
    mod.clearCredentials()
    expect(mod.loadCredentials()).toBeNull()
    expect(mod.loadSession()).toBeNull()
  })

  it('clearCredentials removes .mk and .rt even when credentials.json is missing', () => {
    // Simulate partial login state: secure token files exist but no credentials.json
    mod.saveCredentials(BASE_PARAMS) // creates .mk + .rt
    unlinkSync(join(HOME_DIR, '.sapi', 'credentials.json')) // remove credentials.json
    mod.clearCredentials() // must still clean up .mk and .rt
    expect(existsSync(join(HOME_DIR, '.sapi', '.mk'))).toBe(false)
    expect(existsSync(join(HOME_DIR, '.sapi', '.rt'))).toBe(false)
  })

  // ─── saveApiKey / loadApiKey / clearApiKey ───────────────────────────────────

  it('saveApiKey / loadApiKey round-trips an API key encrypted via .mk', () => {
    mod.saveApiKey('sapi_testkey123')
    expect(mod.loadApiKey()).toBe('sapi_testkey123')
  })

  it('loadApiKey returns SAPI_API_KEY env var when set, ignoring disk', () => {
    mod.saveApiKey('sapi_on_disk')
    vi.stubEnv('SAPI_API_KEY', 'sapi_from_env')
    expect(mod.loadApiKey()).toBe('sapi_from_env')
  })

  it('clearApiKey deletes .ak so subsequent loadApiKey returns null', () => {
    mod.saveApiKey('sapi_to_delete')
    expect(mod.loadApiKey()).toBe('sapi_to_delete')
    mod.clearApiKey()
    expect(mod.loadApiKey()).toBeNull()
  })

  // ─── saveSession / loadSession ───────────────────────────────────────────────

  it('saveSession / loadSession round-trips', () => {
    mod.saveSession({ machineId: 'machine-1' })
    expect(mod.loadSession()).toEqual({ machineId: 'machine-1' })
  })

  it('loadSession returns null when file does not exist', () => {
    expect(mod.loadSession()).toBeNull()
  })

  // ─── requireAuth ─────────────────────────────────────────────────────────────

  it('throws "Not authenticated" when no credentials file exists', async () => {
    await expect(mod.requireAuth()).rejects.toThrow('Not authenticated')
  })

  it('throws "Session expired" when sessionExpiresAt is in the past', async () => {
    // sessionTimeoutMs: -1 places sessionExpiresAt 1ms in the past
    mod.saveCredentials({ ...BASE_PARAMS, sessionTimeoutMs: -1 })
    await expect(mod.requireAuth()).rejects.toThrow('Session expired')
  })

  it('returns credentials unchanged when idToken is fresh (> 5min remaining)', async () => {
    // idTokenExpiresIn: 3600 → expires in 1 hour, well outside the 5-min refresh window
    mod.saveCredentials(BASE_PARAMS)
    const result = await mod.requireAuth()
    expect(result.idToken).toBe('id-token-abc')
  })

  it('calls securetoken refresh when idToken is within 5 minutes of expiry', async () => {
    // idTokenExpiresIn: 120 → expires in 2 minutes, inside the 5-min refresh window
    mod.saveCredentials({ ...BASE_PARAMS, idTokenExpiresIn: 120 })

    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id_token: 'refreshed-id-token',
          refresh_token: 'new-refresh',
          expires_in: '3600',
        }),
        { status: 200 },
      ),
    )

    const result = await mod.requireAuth()

    expect(result.idToken).toBe('refreshed-id-token')
    expect(mockFetch).toHaveBeenCalledOnce()
    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]]
    expect(url).toContain('securetoken.googleapis.com')
  })

  it('persists new idToken to disk after a successful refresh', async () => {
    mod.saveCredentials({ ...BASE_PARAMS, idTokenExpiresIn: 120 })

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id_token: 'persisted-token',
          refresh_token: 'new-refresh',
          expires_in: '3600',
        }),
        { status: 200 },
      ),
    )

    await mod.requireAuth()

    const stored = mod.loadCredentials()
    expect(stored?.idToken).toBe('persisted-token')
    // New refresh token must also be available via secure storage
    expect(stored?.refreshToken).toBe('new-refresh')
  })

  it('throws "Token refresh failed" when securetoken returns a non-2xx error', async () => {
    mod.saveCredentials({ ...BASE_PARAMS, idTokenExpiresIn: 120 })

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'TOKEN_EXPIRED' } }), { status: 400 }),
    )

    await expect(mod.requireAuth()).rejects.toThrow('Token refresh failed')
  })
})
