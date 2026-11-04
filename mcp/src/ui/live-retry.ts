/**
 * How long the task view waits before asking for the live screen again. Every
 * ask is a `POST /machines/:id/live`, rate-limited per caller (120 an hour), so
 * the waits grow while the computer isn't there: 3 s, doubling to 45 s, then
 * steady until the task ends. The cap leaves room in that limit for the short
 * first waits and for a reset or a second view (30 s alone would use all 120). A free computer can take ~3 minutes to boot, so
 * the view keeps asking at the cap rather than giving up. Pure (no DOM), so it
 * runs in the iframe and in vitest alike.
 */
export const LIVE_RETRY_FIRST_MS = 3_000
export const LIVE_RETRY_CAP_MS = 45_000
/** A server's `Retry-After` is honoured up to this, so a bad value can't park the view for good. */
export const LIVE_RETRY_AFTER_MAX_MS = 15 * 60_000

export class LiveRetry {
  private next = LIVE_RETRY_FIRST_MS

  /**
   * The wait before the next ask, and the one after grows. A `Retry-After`
   * (seconds) longer than that wait wins; a 429 without one goes straight to
   * the cap, since asking sooner only spends more of the limit.
   */
  delay(opts: { retryAfterS?: number; rateLimited?: boolean } = {}): number {
    let ms = opts.rateLimited ? LIVE_RETRY_CAP_MS : this.next
    if (opts.retryAfterS !== undefined && Number.isFinite(opts.retryAfterS)) {
      ms = Math.max(ms, Math.min(opts.retryAfterS * 1_000, LIVE_RETRY_AFTER_MAX_MS))
    }
    this.next = Math.min(Math.max(this.next, ms) * 2, LIVE_RETRY_CAP_MS)
    return ms
  }

  /** The screen connected, or a new task started: the next wait starts short again. */
  reset(): void {
    this.next = LIVE_RETRY_FIRST_MS
  }
}
