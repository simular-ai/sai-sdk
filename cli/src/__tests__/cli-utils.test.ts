import { describe, it, expect } from 'vitest'
import { parseDuration, parseChoiceSelection, sanitizeTerminalText } from '../cli-utils.js'

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

// ─── parseChoiceSelection ──────────────────────────────────────────────────────

describe('parseChoiceSelection', () => {
  const opts = [
    { value: 'plan_free', label: 'Free' },
    { value: 'plan_pro', label: 'Pro' },
    { value: 'plan_ent', label: 'Enterprise' },
  ]

  it('selects a single option by 1-based index (returns its value + label)', () => {
    expect(parseChoiceSelection('2', opts, false)).toEqual({
      kind: 'select',
      values: ['plan_pro'],
      labels: ['Pro'],
    })
  })

  it('ignores extra picks when multiple is false (first only)', () => {
    expect(parseChoiceSelection('3, 1', opts, false)).toEqual({
      kind: 'select',
      values: ['plan_ent'],
      labels: ['Enterprise'],
    })
  })

  it('accepts comma-separated picks when multiple is true, deduped, in pick order', () => {
    expect(parseChoiceSelection('3, 1, 3', opts, true)).toEqual({
      kind: 'select',
      values: ['plan_ent', 'plan_free'],
      labels: ['Enterprise', 'Free'],
    })
  })

  it.each(['', 'cancel', 'CANCEL', 'no', 'n', '  cancel  '])('treats %j as cancel', (raw) => {
    expect(parseChoiceSelection(raw, opts, false)).toEqual({ kind: 'cancel' })
  })

  it.each(['0', '4', '99', 'abc', 'two'])(
    'treats out-of-range / non-numeric %j as invalid (input given, no valid index)',
    (raw) => {
      expect(parseChoiceSelection(raw, opts, false)).toEqual({ kind: 'invalid' })
    },
  )

  it('filters out-of-range indices but keeps valid ones (multiple)', () => {
    expect(parseChoiceSelection('1, 9, 3', opts, true)).toEqual({
      kind: 'select',
      values: ['plan_free', 'plan_ent'],
      labels: ['Free', 'Enterprise'],
    })
  })

  // allowOther — a typed answer is the only way to resolve `askUser` without
  // `multipleChoice`, whose question carries no options at all. /approve
  // rejects an approved choice with no selections, so "invalid" there would
  // strand the agent.
  describe('allowOther (typed answers)', () => {
    it('takes the raw text, original case preserved, when nothing matches an index', () => {
      expect(parseChoiceSelection('Use the Staging DB', opts, false, true)).toEqual({
        kind: 'select',
        values: ['Use the Staging DB'],
        labels: ['Use the Staging DB'],
      })
    })

    it('answers a question with no options at all', () => {
      expect(parseChoiceSelection('jamie@simular.ai', [], false, true)).toEqual({
        kind: 'select',
        values: ['jamie@simular.ai'],
        labels: ['jamie@simular.ai'],
      })
    })

    it('still prefers an in-range index over free text', () => {
      expect(parseChoiceSelection('2', opts, false, true)).toEqual({
        kind: 'select',
        values: ['plan_pro'],
        labels: ['Pro'],
      })
    })

    it('keeps "no" as an answer rather than a cancel', () => {
      expect(parseChoiceSelection('no', opts, false, true)).toEqual({
        kind: 'select',
        values: ['no'],
        labels: ['no'],
      })
    })

    it.each(['', '   ', 'cancel', 'CANCEL'])('still cancels on %j', (raw) => {
      expect(parseChoiceSelection(raw, opts, false, true)).toEqual({ kind: 'cancel' })
    })
  })
})

// ─── sanitizeTerminalText ─────────────────────────────────────────────────────

describe('sanitizeTerminalText', () => {
  it('strips ANSI escape sequences (ESC removed, payload chars remain inert)', () => {
    expect(sanitizeTerminalText('Run command: rm \u001b[2K\u001b[1A -rf /')).toBe(
      'Run command: rm [2K[1A -rf /',
    )
  })

  it('strips carriage returns and other C0/C1 controls', () => {
    expect(sanitizeTerminalText('safe echo\r\u0007\u009b31mdanger')).toBe('safe echo31mdanger')
  })

  it('keeps newlines, tabs, and plain unicode text', () => {
    expect(sanitizeTerminalText('line1\nline2\tend — ✓')).toBe('line1\nline2\tend — ✓')
  })

  it('strips Unicode bidi overrides and zero-width chars (Trojan Source)', () => {
    expect(sanitizeTerminalText('safe\u202Erm-rf\u202C')).toBe('saferm-rf')
    expect(sanitizeTerminalText('a\u200bb\u2066c')).toBe('abc')
  })
})
