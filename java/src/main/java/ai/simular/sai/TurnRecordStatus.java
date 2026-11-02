package ai.simular.sai;

/** Turn record statuses, from {@code GET /v1/agents/turns/{id}}. */
public enum TurnRecordStatus {
  RUNNING("running"),
  NEEDS_INPUT("needs_input"),
  FINALIZING("finalizing"),
  SUCCEEDED("succeeded"),
  FAILED("failed");

  private final String value;

  TurnRecordStatus(String value) {
    this.value = value;
  }

  public String value() {
    return value;
  }

  @Override
  public String toString() {
    return value;
  }

  /** {@link #RUNNING} for a value this SDK does not know. */
  static TurnRecordStatus of(String value) {
    for (TurnRecordStatus s : values()) if (s.value.equals(value)) return s;
    return RUNNING;
  }
}
