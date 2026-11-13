package ai.simular.sai;

import java.util.Map;

/**
 * A Tenant's computer: its own, enrolled, or a cloud machine Sai hosts for it.
 *
 * @param status older servers only; empty on servers with cloud machines. Read {@code state}.
 * @param online true when an enrolled machine reported in the last 3 minutes, or a cloud machine
 *     is {@code ready}
 * @param kind {@code enrolled} or {@code cloud}
 * @param state enrolled: {@code online} or {@code offline}. Cloud: {@code provisioning}, {@code
 *     ready}, {@code starting}, {@code hibernated}, {@code deleting} or {@code failed}.
 * @param machineClass cloud only: the billing class, e.g. {@code win32-4c8g}
 * @param createdAt Unix time in milliseconds; null from servers before cloud machines
 * @param capabilities what stands in the way of driving it; null when there is no answer yet: the
 *     machine has not reported (its runtime is too old to, or has not yet), or its check failed;
 *     also from older servers
 */
public record TenantMachine(
    String id,
    String name,
    String platform,
    String status,
    boolean online,
    Long lastSeen,
    String runtimeVersion,
    String kind,
    String state,
    String machineClass,
    Long createdAt,
    MachineCapabilities capabilities,
    Map<String, Object> raw) {

  static TenantMachine parse(Map<String, Object> d) {
    // Servers before cloud machines send `online` and `status` and no `kind` or `state`.
    String s = Json.str(d.get("state"));
    String state = s != null && !s.isEmpty() ? s : Json.truthy(d.get("online")) ? "online" : "offline";
    return new TenantMachine(
        Json.str(d.get("machineId"), ""),
        Json.str(d.get("name")),
        Json.str(d.get("platform")),
        Json.str(d.get("status"), ""),
        d.containsKey("online")
            ? Json.truthy(d.get("online"))
            : state.equals("online") || state.equals("ready"),
        Json.lngOrNull(d.get("lastSeen")),
        Json.str(d.get("runtimeVersion")),
        "cloud".equals(d.get("kind")) ? "cloud" : "enrolled",
        state,
        Json.str(d.get("machineClass")),
        Json.lngOrNull(d.get("createdAt")),
        MachineCapabilities.parse(d.get("capabilities")),
        d);
  }
}
