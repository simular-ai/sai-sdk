package ai.simular.sai;

/** Turn statuses: {@link #RUNNING} while polling, then one of the three others. */
public enum TurnStatus {
  RUNNING("running"),
  IDLE("idle"),
  NEEDS_APPROVAL("needs_approval"),
  ERROR("error");

  private final String value;

  TurnStatus(String value) {
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
  static TurnStatus of(String value) {
    for (TurnStatus s : values()) if (s.value.equals(value)) return s;
    return RUNNING;
  }
}
