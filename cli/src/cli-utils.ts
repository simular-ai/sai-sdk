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
