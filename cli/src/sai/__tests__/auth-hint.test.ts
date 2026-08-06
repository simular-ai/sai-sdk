/**
 * A stored API key outranks the Firebase session, so a revoked one makes every
 * networked command fail with a bare `401 Invalid API key` — the user can be
 * signed in and still locked out, with nothing on screen naming the file that
 * is causing it. These pin the guidance onto the 401 itself.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

const apiKeySource = vi.fn<() => 'env' | 'file' | 'none'>()

vi.mock('../../auth/token-store.js', () => ({ apiKeySource: () => apiKeySource() }))

const { verifyAuth, listMachines } = await import('../client.js')

beforeEach(() => apiKeySource.mockReturnValue('none'))
afterEach(() => vi.restoreAllMocks())

function respond(status: number, body: unknown = { error: 'Invalid API key' }): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status }),
  )
}

describe('401 guidance for a stored API key', () => {
  it('names the key file and how to clear it when the key came from disk', async () => {
    apiKeySource.mockReturnValue('file')
    respond(401)
    await expect(verifyAuth('tok')).rejects.toThrow(/~\/\.simular\/cli\/\.ak/)
  })

  it('mentions that the stored key outranks the signed-in session', async () => {
    apiKeySource.mockReturnValue('file')
    respond(401)
    await expect(verifyAuth('tok')).rejects.toThrow(/takes priority over your/)
  })

  it('stays quiet for a key the caller passed in the environment', async () => {
    apiKeySource.mockReturnValue('env')
    respond(401)
    await expect(verifyAuth('tok')).rejects.not.toThrow(/\.ak/)
  })

  it('stays quiet when no API key is involved at all', async () => {
    respond(401)
    await expect(verifyAuth('tok')).rejects.not.toThrow(/\.ak/)
  })

  it('stays quiet on non-401 failures — a 500 is not an auth problem', async () => {
    apiKeySource.mockReturnValue('file')
    respond(500, { error: 'boom' })
    await expect(verifyAuth('tok')).rejects.not.toThrow(/\.ak/)
  })

  // The hint is attached at every throw site, not just the auth endpoint —
  // `sai whoami` is not the command most users are running when they hit this.
  it('applies to ordinary endpoints too, not just /auth', async () => {
    apiKeySource.mockReturnValue('file')
    respond(401)
    await expect(listMachines('tok')).rejects.toThrow(/\.ak/)
  })
})
