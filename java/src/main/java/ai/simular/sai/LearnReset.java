package ai.simular.sai;

import java.util.Map;

/**
 * What a {@code reset} did before a run or before the agent run.
 *
 * @param kind {@code code} or {@code task}
 * @param turnId a reset task's turn
 */
public record LearnReset(String kind, boolean ok, Long durationMs, String turnId, String error) {
  static LearnReset parse(Object v) {
    if (!(v instanceof Map<?, ?>)) return null;
    Map<String, Object> r = Json.obj(v);
    return new LearnReset(
        "task".equals(r.get("kind")) ? "task" : "code",
        Json.truthy(r.get("ok")),
        Json.lngOrNull(r.get("durationMs")),
        Json.str(r.get("turnId")),
        Json.str(r.get("error")));
  }
}
