package ai.simular.sai;

import java.time.Duration;

/** Options for {@code sai.tenantMachines().create()}. */
public final class CreateMachineOptions {
  String name;
  String requestId;
  boolean waitForReady;
  Duration timeout;

  /** A label you show your users, up to 64 characters. */
  public CreateMachineOptions name(String name) {
    this.name = name;
    return this;
  }

  /**
   * Makes a retry safe (letters, digits, {@code _} and {@code -}, up to 128): the same id and body
   * return the first machine, and the same id with another body throws {@link ConflictException}
   * ({@code request_id_reused}). Without one, every call creates a machine.
   */
  public CreateMachineOptions requestId(String requestId) {
    this.requestId = requestId;
    return this;
  }

  /**
   * Read the machine until it is {@code ready} ({@code wait} in the other SDKs). Throws {@link
   * SaiException} if the machine fails or is deleted, and {@link SaiTimeoutException} after {@code
   * timeout}.
   */
  public CreateMachineOptions waitForReady(boolean waitForReady) {
    this.waitForReady = waitForReady;
    return this;
  }

  /** How long {@code waitForReady} waits. Default 10 minutes. */
  public CreateMachineOptions timeout(Duration timeout) {
    this.timeout = timeout;
    return this;
  }
}
