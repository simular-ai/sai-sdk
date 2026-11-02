package ai.simular.sai;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/** The computers Sai works on: cloud computers, or the customer's own PC with the Sai app. */
public final class Machines {
  private final Http http;

  Machines(Http http) {
    this.http = http;
  }

  public List<Machine> list() {
    Map<String, Object> d = http.object("GET", "/v1/agents/machines");
    List<Machine> out = new ArrayList<>();
    for (Map<String, Object> m : Json.objects(d.get("machines"))) out.add(Machine.parse(m));
    return Collections.unmodifiableList(out);
  }

  /** Throws {@link NotFoundException} when the account has no such machine. */
  public Machine get(String machineId) {
    for (Machine m : list()) if (m.id().equals(machineId)) return m;
    throw new NotFoundException(
        "Machine " + machineId + " not found on this account.", 404, null, null, null);
  }

  /**
   * The live screen: {@code liveUrl}, a page a person can open without a Simular sign-in, and a
   * Guacamole tunnel for a viewer of your own. The machine must be running.
   */
  public LiveView live(String machineId) {
    Map<String, Object> d =
        http.object("POST", "/v1/agents/machines/" + Http.encode(machineId) + "/live");
    return new LiveView(
        Json.str(d.get("machineId"), machineId),
        Json.str(d.get("liveUrl")),
        Json.lngOrNull(d.get("expiresAt")),
        String.valueOf(d.get("websocketUrl")),
        Json.integer(d.get("width")),
        Json.integer(d.get("height")));
  }

  public LiveView live(Machine machine) {
    return live(machine.id());
  }

  /**
   * Revokes every {@code liveUrl} handed out for the machine; returns how many. A page already
   * showing the screen keeps its connection until it closes, but stops taking input within seconds.
   */
  public int revokeLive(String machineId) {
    Map<String, Object> d =
        http.object("DELETE", "/v1/agents/machines/" + Http.encode(machineId) + "/live");
    return Json.integer(d.get("revoked"));
  }

  public int revokeLive(Machine machine) {
    return revokeLive(machine.id());
  }

  String resolveId(String machineId) {
    if (machineId != null && !machineId.isEmpty()) return machineId;
    List<Machine> machines = list();
    if (machines.size() == 1) return machines.get(0).id();
    if (machines.isEmpty()) {
      throw new BadRequestException(
          "No computer on this account. Create one in the Sai app or the portal.", 400, null, null, null);
    }
    List<String> names = new ArrayList<>();
    for (Machine m : machines) names.add(m.name() != null && !m.name().isEmpty() ? m.id() + " (" + m.name() + ")" : m.id());
    throw new BadRequestException(
        "Several computers on this account; pass machine. Candidates: " + String.join(", ", names),
        400, null, null, null);
  }
}
