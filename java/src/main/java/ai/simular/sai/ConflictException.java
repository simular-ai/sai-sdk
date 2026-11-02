package ai.simular.sai;

import java.util.Map;

/** 409: e.g. {@code machine_busy}, {@code link_only}, approval no longer pending. */
public class ConflictException extends SaiException {
  private static final long serialVersionUID = 1L;

  public ConflictException(String message, int status, String code, Map<String, Object> body, Double retryAfter) {
    super(message, status, code, body, retryAfter, null);
  }
}
