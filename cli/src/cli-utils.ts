/**
 * Parses a duration string like "30s", "24h", "7d", "30m" into milliseconds.
 * Falls back to 72 hours with a console warning on unrecognised input.
 */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000)}h`
}

export function parseDuration(s: string): number | null {
  const match = s.match(/^(\d+)(s|m|h|d)$/)
  if (!match) return null
  const n = parseInt(match[1], 10)
  const unit = match[2] as 's' | 'm' | 'h' | 'd'
  const ms: Record<'s' | 'm' | 'h' | 'd', number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  }
  return n * ms[unit]
}

// C0/C1 control characters (incl. ESC) — everything that could carry an ANSI
// escape sequence — plus Unicode bidi overrides and zero-width chars (Trojan
// Source-style). Server-derived text (approval cards, agent deltas, status
// lines) is printed straight to the terminal; without stripping, a malicious
// command string could rewrite the approval prompt or reverse displayed text.
const UNSAFE_TERMINAL_CHARS =
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

/** Strip terminal control / bidi / zero-width characters from server-derived text. */
export function sanitizeTerminalText(text: string): string {
  return text.replace(UNSAFE_TERMINAL_CHARS, '')
}

export interface ChoiceOption {
  value: string
  label: string
}

export type ChoiceSelectionResult =
  | { kind: 'cancel' } // explicit cancel / empty / no
  | { kind: 'invalid' } // input given, but no in-range index
  | { kind: 'select'; values: string[]; labels: string[] }

/**
 * Parse a user's reply to an askChoice prompt into a resolution. Pure — the
 * interactive prompt in cli.ts feeds `raw` here and acts on the result.
 * - "" / "cancel" / "no" / "n" → cancel
 * - comma-separated 1-based indices → select (deduped; only the first unless
 *   `multiple`); values/labels map back to the options in pick order
 * - input given but no in-range index → invalid
 */
export function parseChoiceSelection(
  raw: string,
  options: ReadonlyArray<ChoiceOption>,
  multiple: boolean,
): ChoiceSelectionResult {
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === '' || trimmed === 'cancel' || trimmed === 'no' || trimmed === 'n') {
    return { kind: 'cancel' }
  }
  const picks = trimmed
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= options.length)
  const unique = [...new Set(multiple ? picks : picks.slice(0, 1))]
  if (unique.length === 0) return { kind: 'invalid' }
  return {
    kind: 'select',
    values: unique.map((n) => options[n - 1].value),
    labels: unique.map((n) => options[n - 1].label),
  }
}
