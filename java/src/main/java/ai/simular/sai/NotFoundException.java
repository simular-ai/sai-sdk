package ai.simular.sai;

import java.util.Map;

/** 404. */
public class NotFoundException extends SaiException {
  private static final long serialVersionUID = 1L;

  public NotFoundException(String message, int status, String code, Map<String, Object> body, Double retryAfter) {
    super(message, status, code, body, retryAfter, null);
  }
}
