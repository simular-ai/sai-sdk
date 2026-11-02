package ai.simular.sai;

import java.util.Map;

/**
 * One step the agent took: what it did, and why. Fetch its screen with {@code
 * sai.turns().screenshot()}.
 *
 * @param isFinal the screenshot taken when the turn ended, after the last step ({@code final} in
 *     the other SDKs, a reserved word in Java)
 * @param rationale the agent's text before the action
 */
public record TrajectoryStep(
    int index,
    boolean isFinal,
    String timestamp,
    String title,
    String code,
    String rationale,
    String error,
    boolean hasScreenshot,
    Map<String, Object> raw) {

  static TrajectoryStep parse(Map<String, Object> d) {
    return new TrajectoryStep(
        Json.integer(d.get("index")),
        Json.truthy(d.get("final")),
        Json.str(d.get("timestamp"), ""),
        Json.str(d.get("title")),
        Json.str(d.get("code")),
        Json.str(d.get("rationale")),
        Json.str(d.get("error")),
        Json.truthy(d.get("screenshot")),
        d);
  }
}
