package ai.simular.sai;

import java.util.Map;

/** 403: the key is valid but the account may not do this (plan, ownership). */
public class PermissionDeniedException extends SaiException {
  private static final long serialVersionUID = 1L;

  public PermissionDeniedException(String message, int status, String code, Map<String, Object> body, Double retryAfter) {
    super(message, status, code, body, retryAfter, null);
  }
}
