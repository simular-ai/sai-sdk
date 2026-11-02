package ai.simular.sai;

import java.util.Map;

/** A model a session can run on; {@code allowed} says whether this plan may use it. */
public record Model(
    String id,
    String name,
    String provider,
    String tier,
    String costTier,
    boolean allowed,
    Map<String, Object> raw) {

  static Model parse(Map<String, Object> d) {
    String id = Json.str(d.get("id"), "");
    return new Model(
        id,
        Json.str(d.get("name"), id),
        Json.str(d.get("provider"), ""),
        Json.str(d.get("tier"), ""),
        Json.str(d.get("costTier"), ""),
        !d.containsKey("allowed") || Json.truthy(d.get("allowed")),
        d);
  }
}
