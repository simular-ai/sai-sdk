package ai.simular.sai;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A non-2xx response from the Sai API. {@link #code()} is the machine-readable {@code error} string
 * when the server sent one ({@code machine_busy}, {@code link_only}, ...); {@link #getMessage()} is
 * the human text; {@link #body()} is the parsed JSON body, unchanged.
 */
public class SaiException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  private final int status;
  private final String code;
  private final transient Map<String, Object> body;
  private final Double retryAfter;

  public SaiException(String message) {
    this(message, 0, null, null, null, null);
  }

  public SaiException(
      String message,
      int status,
      String code,
      Map<String, Object> body,
      Double retryAfter,
      Throwable cause) {
    super(message, cause);
    this.status = status;
    this.code = code;
    this.body =
        body == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(body));
    this.retryAfter = retryAfter;
  }

  /** The HTTP status; 0 when no response came back. */
  public int status() {
    return status;
  }

  /** The machine-readable error code, or null. */
  public String code() {
    return code;
  }

  /** The parsed JSON body. */
  public Map<String, Object> body() {
    return body;
  }

  /** Seconds to wait before retrying ({@code Retry-After}, or {@code retryAfterSeconds}), or null. */
  public Double retryAfter() {
    return retryAfter;
  }

  /** The exception for a response: by {@code code} first, then by status. */
  static SaiException forResponse(int status, Map<String, Object> body, Double retryAfter) {
    Object err = body.get("error");
    Object detail = body.get("message");
    // Two body shapes: { error: "<human text>" } (/v1/agents) and
    // { error: "<code>", message: "<human text>" } (/v1/machines/{id}/control, newer errors).
    String code =
        err instanceof String s && (body.containsKey("message") || looksLikeCode(s)) ? s : null;
    String message =
        detail instanceof String d ? d : err instanceof String s ? s : "HTTP " + status;
    if (status == 401) message += " (SAI_API_KEY was rejected: it may be revoked.)";
    // The Retry-After header wins; retryAfterSeconds is the same value in the body (rate_limited).
    Double wait =
        retryAfter != null
            ? retryAfter
            : body.get("retryAfterSeconds") instanceof Number n ? n.doubleValue() : null;
    if ("link_only".equals(code)) {
      return new LinkOnlyApprovalException(message, status, code, body, wait);
    }
    if ("spend_cap_reached".equals(code)) {
      return new SpendCapReachedException(message, status, code, body, wait);
    }
    return switch (status) {
      case 400 -> new BadRequestException(message, status, code, body, wait);
      case 401 -> new AuthenticationException(message, status, code, body, wait);
      case 403 -> new PermissionDeniedException(message, status, code, body, wait);
      case 404 -> new NotFoundException(message, status, code, body, wait);
      case 409 -> new ConflictException(message, status, code, body, wait);
      case 410 -> new GoneException(message, status, code, body, wait);
      case 429 -> new RateLimitException(message, status, code, body, wait);
      case 503 -> new ServiceUnavailableException(message, status, code, body, wait);
      default -> new SaiException(message, status, code, body, wait, null);
    };
  }

  private static boolean looksLikeCode(String s) {
    return !s.isEmpty() && !s.contains(" ") && s.equals(s.toLowerCase(java.util.Locale.ROOT));
  }
}
