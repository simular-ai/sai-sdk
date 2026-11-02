package ai.simular.sai;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** A conversation with Sai. Each {@code send()} is a turn; turns share context. */
public final class Session {
  private final Http http;
  private volatile String machineId;
  private volatile String id;

  Session(Http http, String machineId, String id) {
    this.http = http;
    this.machineId = machineId;
    this.id = id;
  }

  /** The session id; null until the first message of a session that has no conversation yet. */
  public String id() {
    return id;
  }

  /** The computer it runs on; null for a resumed session given no machine. */
  public String machineId() {
    return machineId;
  }

  public Turn send(String message) {
    return send(message, new SendOptions());
  }

  /**
   * Give Sai a task, or steer the running one. Returns at once. Sent while a turn is running, the
   * message steers that turn ({@code turn.queued()} is true).
   *
   * <p>Any of {@code inputs}, {@code outputSchema} or {@code successCriteria} makes the message
   * structured: {@code waitFor()} then also returns the turn's record in {@code result.record()}.
   * A structured message is refused with {@link ConflictException} ({@code session_busy}) while a
   * turn is running.
   */
  public Turn send(String message, SendOptions opts) {
    SendOptions o = opts == null ? new SendOptions() : opts;
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("message", message);
    body.put("wait", false);
    if (machineId != null && !machineId.isEmpty()) body.put("machineId", machineId);
    if (id != null && !id.isEmpty()) body.put("sessionId", id);
    if (o.model != null && !o.model.isEmpty()) body.put("model", o.model);
    if (o.attachments != null && !o.attachments.isEmpty()) {
      List<Object> raw = new ArrayList<>();
      for (Attachment a : o.attachments) raw.add(a.raw());
      body.put("attachments", raw);
    }
    if (o.autonomous) body.put("autonomous", true);
    Map<String, Object> options = new LinkedHashMap<>();
    if (o.inputs != null) options.put("inputs", o.inputs);
    if (o.outputSchema != null) options.put("output_schema", o.outputSchema);
    if (o.successCriteria != null) options.put("success_criteria", Check.criteria(o.successCriteria));
    if (o.idempotencyKey != null) options.put("idempotency_key", o.idempotencyKey);
    if (o.recordTrajectory) options.put("recordTrajectory", true);
    if (o.thinkingLevel != null) options.put("thinkingLevel", o.thinkingLevel);
    if (!options.isEmpty()) body.put("options", options);
    boolean structured = o.structured();
    Map<String, Object> d = http.object("POST", "/v1/agents/message", Http.Req.json(body));
    if (Json.truthy(d.get("idempotent_replay"))) {
      // The key was used before: this is that turn, and nothing was sent.
      TurnRecord record = TurnRecord.parse(d);
      if (record.sessionId() != null) id = record.sessionId();
      if (!record.machineId().isEmpty()) machineId = record.machineId();
      return new Turn(this, http, false, null, record.id(), structured, record);
    }
    String sessionId = Json.str(d.get("sessionId"));
    if (sessionId == null || sessionId.isEmpty()) {
      // Handled without starting a task (e.g. a plain acknowledgement): the reply is in `reply`,
      // or in `error` on servers before `reply` existed.
      String text = Json.str(d.get("reply"), Json.str(d.get("error"), ""));
      return new Turn(this, http, false, TurnResult.local(id == null ? "" : id, text), null, false, null);
    }
    id = sessionId;
    if (d.get("machineId") instanceof String m) machineId = m;
    return new Turn(this, http, Json.truthy(d.get("queued")), null, Json.str(d.get("turnId")), structured, null);
  }

  /** {@code send()} then {@code waitFor()}: the answer, or where it stopped. */
  public TurnResult run(String message) {
    return send(message).waitFor();
  }

  public TurnResult run(String message, SendOptions send) {
    return send(message, send).waitFor();
  }

  public TurnResult run(String message, WaitOptions wait) {
    return send(message).waitFor(wait);
  }

  public TurnResult run(String message, SendOptions send, WaitOptions wait) {
    return send(message, send).waitFor(wait);
  }

  /** Stop the running turn. Pending approvals are denied. False if nothing was running. */
  public boolean abort() {
    if (id == null || id.isEmpty()) return false;
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("sessionId", id);
    return Json.truthy(http.object("POST", "/v1/agents/abort", Http.Req.json(body)).get("aborted"));
  }

  /** Answer an approval with {@code yes}. */
  public String respond(Approval approval) {
    return respond(approval, "yes", null);
  }

  public String respond(Approval approval, String response) {
    return respond(approval, response, null);
  }

  /**
   * Answer an approval: {@code yes}, {@code no}, or {@code task} (allow for the rest of the task).
   * A {@code choice} approval needs {@code selections}, one list of option values per question.
   * Throws {@link LinkOnlyApprovalException} (with {@code approvalUrl()}) when only a browser can
   * answer it. Returns {@code approved}, {@code approved_task} or {@code denied}.
   */
  public String respond(Approval approval, String response, List<List<String>> selections) {
    if (approval.isLinkOnly()) {
      Map<String, Object> body = new LinkedHashMap<>();
      body.put("approvalUrl", approval.url());
      throw new LinkOnlyApprovalException(
          "This approval must be completed in a browser. Open approval.url().", 409, "link_only", body, null);
    }
    return respond(approval.id(), response, selections);
  }

  public String respond(String approvalId) {
    return respond(approvalId, "yes", null);
  }

  public String respond(String approvalId, String response) {
    return respond(approvalId, response, null);
  }

  public String respond(String approvalId, String response, List<List<String>> selections) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("approvalId", approvalId);
    body.put("response", response == null ? "yes" : response);
    if (selections != null) body.put("selections", selections);
    return Json.str(http.object("POST", "/v1/agents/approve", Http.Req.json(body)).get("status"), "");
  }
}
