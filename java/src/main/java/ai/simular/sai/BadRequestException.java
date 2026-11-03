package ai.simular.sai;

import java.util.Map;

/** 400: the request was invalid, e.g. several computers and no machine. */
public class BadRequestException extends SaiException {
  private static final long serialVersionUID = 1L;

  public BadRequestException(String message, int status, String code, Map<String, Object> body, Double retryAfter) {
    super(message, status, code, body, retryAfter, null);
  }
}
