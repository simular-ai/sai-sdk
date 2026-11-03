package ai.simular.sai;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Sessions: a conversation with Sai on one computer. Sai decides every click. A machine may be left
 * out when the account has one computer.
 */
public final class Sessions {
  private final Http http;
  private final Machines machines;

  Sessions(Http http, Machines machines) {
    this.http = http;
    this.machines = machines;
  }

  /** Start a fresh conversation on the account's only computer. */
  public Session create() {
    return create((String) null);
  }

  public Session create(Machine machine) {
    return create(machine.id());
  }

  /**
   * Start a fresh conversation on a computer: the next message has no memory of earlier ones.
   */
  public Session create(String machineId) {
    String id = machines.resolveId(machineId);
    String sessionId = null;
    try {
      Map<String, Object> body = new LinkedHashMap<>();
      body.put("machineId", id);
      body.put("channel", "api");
      sessionId = Json.str(http.object("POST", "/v1/agents/new-session", Http.Req.json(body)).get("sessionId"));
    } catch (NotFoundException e) {
      // A free account's computer between claims has no conversation to rotate; the first message
      // starts one.
    }
    return new Session(http, id, sessionId);
  }

  /** {@link #list(String)} on the account's only computer. */
  public List<SessionSummary> list() {
    return list((String) null);
  }

  public List<SessionSummary> list(Machine machine) {
    return list(machine.id());
  }

  /**
   * The caller's sessions on a computer (desktop, CLI and API), most recent first (up to 20).
   * {@code active} marks the API channel's current one, which the next message without a session
   * goes to.
   */
  public List<SessionSummary> list(String machineId) {
    String id = machines.resolveId(machineId);
    Map<String, Object> params = new LinkedHashMap<>();
    params.put("machineId", id);
    params.put("channel", "api");
    Map<String, Object> d = http.object("GET", "/v1/agents/sessions", Http.Req.params(params));
    List<SessionSummary> out = new ArrayList<>();
    for (Map<String, Object> s : Json.objects(d.get("sessions"))) out.add(SessionSummary.parse(s));
    return Collections.unmodifiableList(out);
  }

  /** Reattach to a session started elsewhere, e.g. to poll or abort it. */
  public Session resume(String sessionId) {
    return new Session(http, null, sessionId);
  }

  public Session resume(String sessionId, String machineId) {
    return new Session(http, machineId == null || machineId.isEmpty() ? null : machineId, sessionId);
  }

  public Session resume(String sessionId, Machine machine) {
    return resume(sessionId, machine.id());
  }
}
