package ai.simular.sai;

/**
 * Where a turn stopped. {@code status} is idle (done: {@code text} is the answer), error, or
 * needs_approval (waiting on {@code approval}; answer it and wait again). {@code record} is the
 * turn's record for a structured message (one with {@code inputs}, {@code outputSchema} or {@code
 * successCriteria}).
 *
 * @param ok idle, and for a structured message, the turn succeeded
 */
public record TurnResult(
    TurnStatus status,
    String text,
    String sessionId,
    Approval approval,
    String error,
    String errorCode,
    Usage usage,
    Usage sessionUsage,
    TurnRecord record,
    boolean ok) {

  static TurnResult local(String sessionId, String text) {
    return new TurnResult(TurnStatus.IDLE, text, sessionId, null, null, null, null, null, null, true);
  }

  TurnResult withRecord(TurnRecord r) {
    return new TurnResult(
        status, text, sessionId, approval, error, errorCode, usage, sessionUsage, r,
        status == TurnStatus.IDLE && r.ok());
  }
}
