package ai.simular.sai;

import java.util.Map;

/** The approval must be answered by a human in a browser: open {@link #approvalUrl()}. */
public class LinkOnlyApprovalException extends ConflictException {
  private static final long serialVersionUID = 1L;

  public LinkOnlyApprovalException(
      String message, int status, String code, Map<String, Object> body, Double retryAfter) {
    super(message, status, code, body, retryAfter);
  }

  /** The page where a person answers the approval, or null. */
  public String approvalUrl() {
    return Json.str(body().get("approvalUrl"));
  }
}
