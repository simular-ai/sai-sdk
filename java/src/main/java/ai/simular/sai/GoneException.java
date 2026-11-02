package ai.simular.sai;

import java.util.Map;

/**
 * 410 {@code control_closed}: the control lease has ended (closed, sat idle, lost the computer to a
 * Sai task, or the computer stopped answering). {@code body().get("reason")} says which. Open a new
 * one.
 */
public class GoneException extends SaiException {
  private static final long serialVersionUID = 1L;

  public GoneException(String message, int status, String code, Map<String, Object> body, Double retryAfter) {
    super(message, status, code, body, retryAfter, null);
  }
}
