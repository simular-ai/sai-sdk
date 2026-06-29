import { describe, it, expect } from 'vitest'
import { parseDuration } from '../cli-utils.js'

// ─── parseDuration ────────────────────────────────────────────────────────────

describe('parseDuration', () => {
  it('parses minutes', () => {
    expect(parseDuration('30m')).toBe(30 * 60_000)
    expect(parseDuration('1m')).toBe(60_000)
  })

  it('parses hours', () => {
    expect(parseDuration('24h')).toBe(24 * 3_600_000)
    expect(parseDuration('72h')).toBe(72 * 3_600_000)
  })

  it('parses days', () => {
    expect(parseDuration('7d')).toBe(7 * 86_400_000)
    expect(parseDuration('1d')).toBe(86_400_000)
  })

  it('returns null for unrecognised formats', () => {
    expect(parseDuration('abc')).toBeNull()
    expect(parseDuration('24')).toBeNull()
    expect(parseDuration('h')).toBeNull()
    expect(parseDuration('')).toBeNull()
    expect(parseDuration('2w')).toBeNull()
  })
})
