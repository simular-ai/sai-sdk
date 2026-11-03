package ai.simular.sai;

import java.util.Map;

/** 429: a rate limit, or a free-plan budget that resets daily. */
public class RateLimitException extends SaiException {
  private static final long serialVersionUID = 1L;

  public RateLimitException(String message, int status, String code, Map<String, Object> body, Double retryAfter) {
    super(message, status, code, body, retryAfter, null);
  }
}
