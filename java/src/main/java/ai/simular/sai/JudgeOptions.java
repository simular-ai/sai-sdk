package ai.simular.sai;

import java.time.Duration;

/** Options for {@code sai.judge().create()}. */
public final class JudgeOptions {
  String task;
  String idempotencyKey;
  Duration timeout;

  /** Default: the first turn's message. */
  public JudgeOptions task(String task) {
    this.task = task;
    return this;
  }

  public JudgeOptions idempotencyKey(String idempotencyKey) {
    this.idempotencyKey = idempotencyKey;
    return this;
  }

  /** The request's timeout. Default 3 minutes. */
  public JudgeOptions timeout(Duration timeout) {
    this.timeout = timeout;
    return this;
  }
}
