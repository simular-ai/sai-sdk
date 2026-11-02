package ai.simular.sai;

import java.util.concurrent.CancellationException;

final class Sleep {
  private Sleep() {}

  static void millis(long ms) {
    if (ms <= 0) return;
    try {
      Thread.sleep(ms);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      CancellationException c = new CancellationException("Interrupted while waiting.");
      c.initCause(e);
      throw c;
    }
  }

  /** After a {@link RateLimitException}: its {@code retryAfter}, or 30 s without one. */
  static void retryAfter(RateLimitException e) {
    millis((long) ((e.retryAfter() != null ? e.retryAfter() : 30) * 1000));
  }
}
