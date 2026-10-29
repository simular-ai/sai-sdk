import { describe, expect, it } from 'vitest'

import {
  LIVE_RETRY_AFTER_MAX_MS,
  LIVE_RETRY_CAP_MS,
  LIVE_RETRY_FIRST_MS,
  LiveRetry,
} from '../ui/live-retry.js'

describe('task view live-screen back-off', () => {
  it('starts at 3 s and doubles to a 30 s cap', () => {
    const r = new LiveRetry()
    const waits = Array.from({ length: 7 }, () => r.delay())
    expect(waits).toEqual([3_000, 6_000, 12_000, 24_000, 30_000, 30_000, 30_000])
    expect(LIVE_RETRY_FIRST_MS).toBe(3_000)
    expect(LIVE_RETRY_CAP_MS).toBe(30_000)
  })

  it('keeps asking through a ~3 minute free-computer boot, within the 120/hour limit', () => {
    const r = new LiveRetry()
    let elapsed = 0
    let asks = 0
    while (elapsed < 3 * 60_000) {
      elapsed += r.delay()
      asks++
    }
    // Never gives up: still asking at the cap after the boot.
    expect(r.delay()).toBe(LIVE_RETRY_CAP_MS)
    // The old fixed 8 s wait asked ~23 times in 3 minutes (and 450 an hour).
    expect(asks).toBeLessThanOrEqual(10)
    // An hour at the cap stays within the server's per-caller limit.
    expect(3_600_000 / LIVE_RETRY_CAP_MS).toBeLessThanOrEqual(120)
  })

  it('resets once the screen connects or a new task starts', () => {
    const r = new LiveRetry()
    r.delay()
    r.delay()
    r.delay()
    r.reset()
    expect(r.delay()).toBe(3_000)
  })

  it('honours a longer Retry-After, and keeps growing from there', () => {
    const r = new LiveRetry()
    expect(r.delay({ retryAfterS: 20 })).toBe(20_000)
    expect(r.delay()).toBe(30_000)
  })

  it('does not wait less than its own back-off for a short Retry-After', () => {
    const r = new LiveRetry()
    r.delay()
    r.delay()
    expect(r.delay({ retryAfterS: 1 })).toBe(12_000)
  })

  it('bounds a huge Retry-After', () => {
    expect(new LiveRetry().delay({ retryAfterS: 86_400 })).toBe(LIVE_RETRY_AFTER_MAX_MS)
  })

  it('goes straight to the cap on a 429 without Retry-After', () => {
    const r = new LiveRetry()
    expect(r.delay({ rateLimited: true })).toBe(LIVE_RETRY_CAP_MS)
    expect(r.delay()).toBe(LIVE_RETRY_CAP_MS)
  })
})
