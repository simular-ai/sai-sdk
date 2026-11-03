package ai.simular.sai;

import java.util.Map;

/**
 * 403 {@code spend_cap_reached}: the key reached its monthly spend limit, or (on a cloud machine
 * create, {@code body().get("scope")} is {@code tenant}) the Tenant reached its budget. Not
 * retryable: the limit resets at {@link #resetsAt()} (ISO 8601, 00:00 UTC on the 1st), or raise it
 * for the key in the portal.
 */
public class SpendCapReachedException extends PermissionDeniedException {
  private static final long serialVersionUID = 1L;

  public SpendCapReachedException(
      String message, int status, String code, Map<String, Object> body, Double retryAfter) {
    super(message, status, code, body, retryAfter);
  }

  /** When the limit resets, ISO 8601, or null. */
  public String resetsAt() {
    return Json.str(body().get("resetsAt"));
  }
}
