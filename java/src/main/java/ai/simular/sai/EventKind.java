package ai.simular.sai;

/** The SDK's event kinds. {@link #OTHER} only appears with {@code raw(true)}. */
public enum EventKind {
  STEP("step"),
  MESSAGE("message"),
  APPROVAL("approval"),
  TOOL_ERROR("tool_error"),
  ERROR("error"),
  FINISHED("finished"),
  OTHER("other");

  private final String value;

  EventKind(String value) {
    this.value = value;
  }

  /** The kind's name, as in every SDK: {@code step}, {@code tool_error}, ... */
  public String value() {
    return value;
  }

  @Override
  public String toString() {
    return value;
  }

  // Wire event type → SDK kind. Anything not listed is framing or internal detail.
  static EventKind ofWireType(String type) {
    return switch (type) {
      case "data-progress" -> STEP;
      case "text-delta" -> MESSAGE;
      case "data-approval-request" -> APPROVAL;
      case "tool-output-error" -> TOOL_ERROR;
      case "error" -> ERROR;
      case "finish" -> FINISHED;
      default -> OTHER;
    };
  }
}
