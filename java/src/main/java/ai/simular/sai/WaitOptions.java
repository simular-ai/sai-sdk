package ai.simular.sai;

import java.time.Duration;

/** Options for {@code turn.waitFor()} and {@code session.run()}. */
public final class WaitOptions {
  ApprovalHandler onApproval;
  Duration timeout;
  Duration pollWait;

  /**
   * Answers each approval as it comes. Without one, the wait returns with {@code needs_approval}.
   */
  public WaitOptions onApproval(ApprovalHandler onApproval) {
    this.onApproval = onApproval;
    return this;
  }

  /** Throws {@link SaiTimeoutException} after this long, with the turn still running. */
  public WaitOptions timeout(Duration timeout) {
    this.timeout = timeout;
    return this;
  }

  /** How long the server may hold one poll (whole seconds); it caps at 60. Default 30 s. */
  public WaitOptions pollWait(Duration pollWait) {
    this.pollWait = pollWait;
    return this;
  }
}
