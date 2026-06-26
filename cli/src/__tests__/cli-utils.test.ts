import { describe, it, expect } from 'vitest'
import { parseDuration, collectPositionalArgs } from '../cli-utils.js'

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

  it('defaults to 72h for unrecognised formats', () => {
    expect(parseDuration('abc')).toBe(72 * 3_600_000)
    expect(parseDuration('24')).toBe(72 * 3_600_000)
    expect(parseDuration('h')).toBe(72 * 3_600_000)
    expect(parseDuration('')).toBe(72 * 3_600_000)
    expect(parseDuration('2w')).toBe(72 * 3_600_000)
  })
})

// ─── collectPositionalArgs ────────────────────────────────────────────────────

describe('collectPositionalArgs', () => {
  it('returns bare positional tokens', () => {
    expect(collectPositionalArgs(['hello', 'world'])).toEqual(['hello', 'world'])
  })

  it('returns a single quoted message (one arg with spaces) as one token', () => {
    expect(collectPositionalArgs(['hello world'])).toEqual(['hello world'])
  })

  it('skips short -f flag and its value', () => {
    expect(collectPositionalArgs(['-f', 'file.txt', 'message'])).toEqual(['message'])
  })

  it('skips long --file flag and its value', () => {
    expect(collectPositionalArgs(['--file', 'file.txt', 'message'])).toEqual(['message'])
  })

  it('skips multiple -f pairs', () => {
    expect(collectPositionalArgs(['-f', 'a.txt', '-f', 'b.txt', 'message'])).toEqual(['message'])
  })

  it('skips --verbose and its space-separated value', () => {
    // --verbose 3 "do a task" must not treat "3" as a positional
    expect(collectPositionalArgs(['--verbose', '3', 'do a task'])).toEqual(['do a task'])
    expect(collectPositionalArgs(['--verbose', '3'])).toEqual([])
  })

  it('skips --verbose=n form via the starts-with-dash rule', () => {
    expect(collectPositionalArgs(['--verbose=3', 'do a task'])).toEqual(['do a task'])
  })

  it('treats everything after -- as positional', () => {
    expect(collectPositionalArgs(['--', 'hello', 'world'])).toEqual(['hello', 'world'])
  })

  it('returns empty array for empty input', () => {
    expect(collectPositionalArgs([])).toEqual([])
  })

  it('returns empty array when only flags are present', () => {
    expect(collectPositionalArgs(['--verbose', '2', '-f', 'file.txt'])).toEqual([])
  })

  // Unknown value-taking flags are NOT handled: the flag token is skipped but its
  // value is treated as a positional. This is fine in practice because Commander
  // rejects unknown flags before the default action (and collectPositionalArgs) runs.
  it('skips unknown boolean-style flags but picks up the value of unknown value-taking flags', () => {
    expect(collectPositionalArgs(['--unknown-bool', 'message'])).toEqual(['message'])
    expect(collectPositionalArgs(['--unknown-value', 'thevalue'])).toEqual(['thevalue'])
  })
})
