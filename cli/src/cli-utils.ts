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
  const ms: Record<'s' | 'm' | 'h' | 'd', number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  return n * ms[unit]
}

/**
 * Returns the non-option positional tokens from an argv array (already sliced past
 * the node binary and script path, i.e. process.argv.slice(2)).
 *
 * Used to detect whether the user passed a bare word / multiple words (command
 * attempt) vs a single quoted string with spaces (a real message to Sai).
 * Skips option flags and consumes the value of --file / -f.
 */
// Options that take a value argument (space-separated form: --opt val).
// These must be listed so collectPositionalArgs skips the value token too.
// Note: --opt=val form is handled automatically (the whole token starts with '-').
const VALUE_OPTIONS = new Set(['--file', '-f', '--verbose', '--timeout'])

export function collectPositionalArgs(argv: string[]): string[] {
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (VALUE_OPTIONS.has(arg)) {
      i++ // skip the value token
      continue
    }
    if (arg.startsWith('-')) continue
    positional.push(arg)
  }
  return positional
}
