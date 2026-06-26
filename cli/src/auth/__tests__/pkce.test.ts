import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { generatePkce } from '../pkce.js'

describe('generatePkce', () => {
  it('generates a base64url codeVerifier from 32 random bytes (43 chars, no padding)', () => {
    const { codeVerifier } = generatePkce()
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(codeVerifier.length).toBe(43)
  })

  it('codeChallenge is the SHA-256 of codeVerifier in base64url', () => {
    const { codeVerifier, codeChallenge } = generatePkce()
    const expected = createHash('sha256').update(codeVerifier).digest('base64url')
    expect(codeChallenge).toBe(expected)
  })

  it('produces a unique pair on each call', () => {
    const a = generatePkce()
    const b = generatePkce()
    expect(a.codeVerifier).not.toBe(b.codeVerifier)
    expect(a.codeChallenge).not.toBe(b.codeChallenge)
  })
})
