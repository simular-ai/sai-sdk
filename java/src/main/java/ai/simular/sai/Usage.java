package ai.simular.sai;

import java.util.Map;

/** Tokens and cost of model calls. */
public record Usage(
    long inputTokens,
    long outputTokens,
    long cacheReadTokens,
    long cacheWriteTokens,
    double costUsd,
    long modelCalls,
    Map<String, Object> byModel) {

  /** Null when {@code d} is not an object. */
  static Usage parse(Object d) {
    if (!(d instanceof Map<?, ?>)) return null;
    Map<String, Object> u = Json.obj(d);
    return new Usage(
        Json.lng(u.get("inputTokens")),
        Json.lng(u.get("outputTokens")),
        Json.lng(u.get("cacheReadTokens")),
        Json.lng(u.get("cacheWriteTokens")),
        Json.num(u.get("costUsd")),
        Json.lng(u.get("modelCalls")),
        Json.obj(u.get("byModel")));
  }
}
