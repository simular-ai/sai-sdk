import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let homeDir = ''

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => homeDir }
})

const authMocks = vi.hoisted(() => ({
  performGoogleOAuth: vi.fn(),
}))

vi.mock('../auth/google-oauth.js', () => authMocks)

describe('sai login', () => {
  let originalArgv: string[]

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'sai-login-test-'))
    originalArgv = process.argv
    process.argv = ['node', 'sai', 'login', '--timeout', '30d']
    authMocks.performGoogleOAuth.mockResolvedValue({
      firebaseIdToken: 'id-token',
      refreshToken: 'refresh-token',
      idTokenExpiresIn: 3600,
      email: 'test@example.com',
      userId: 'test-user',
    })
    vi.resetModules()
  })

  afterEach(() => {
    process.argv = originalArgv
    rmSync(homeDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('applies the login timeout instead of the root inactivity timeout', async () => {
    await import('../cli.js')

    const credentialsPath = join(homeDir, '.simular', 'cli', 'credentials.json')
    await vi.waitFor(() => expect(existsSync(credentialsPath)).toBe(true))

    const credentials = JSON.parse(readFileSync(credentialsPath, 'utf-8')) as {
      sessionTimeoutMs: number
    }
    expect(credentials.sessionTimeoutMs).toBe(30 * 86_400_000)
  })
})
