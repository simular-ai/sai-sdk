package ai.simular.sai;

import java.util.Map;

/** 503: the computer did not come online, or no capacity. Honor {@link #retryAfter()}. */
public class ServiceUnavailableException extends SaiException {
  private static final long serialVersionUID = 1L;

  public ServiceUnavailableException(String message, int status, String code, Map<String, Object> body, Double retryAfter) {
    super(message, status, code, body, retryAfter, null);
  }
}
