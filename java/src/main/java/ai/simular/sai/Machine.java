package ai.simular.sai;

import java.util.Map;

/**
 * A computer Sai works on: a cloud computer, or a PC with the Sai app.
 *
 * @param kind {@code cloud} (hosted by Simular) or {@code own} (a desktop with the Sai app)
 * @param online true when a message can reach it now (a hibernated cloud computer wakes on the
 *     first message)
 * @param state {@code running}, {@code starting}, {@code asleep}, {@code creating} or {@code
 *     unknown}; null on servers that do not send it yet. Prefer it over {@code status}.
 * @param status deprecated: the server's internal lifecycle value; use {@code state}
 * @param os {@code windows}, {@code linux}, {@code macOS} or {@code android}; null when unknown
 * @param capabilities what stands in the way of driving it; null for a cloud machine, before the
 *     runtime has reported, from a runtime older than 0.1.3, when its check failed, and from older
 *     servers
 */
public record Machine(
    String id,
    String name,
    String kind,
    boolean online,
    String state,
    String status,
    boolean canWake,
    String os,
    MachineCapabilities capabilities,
    Map<String, Object> raw) {

  static Machine parse(Map<String, Object> d) {
    return new Machine(
        Json.str(d.get("machineId"), ""),
        Json.str(d.get("name")),
        Json.str(d.get("kind"), ""),
        Json.truthy(d.get("online")),
        Json.str(d.get("state")),
        Json.str(d.get("status")),
        Json.truthy(d.get("canWake")),
        Json.str(d.get("os")),
        MachineCapabilities.parse(d.get("capabilities")),
        d);
  }
}
