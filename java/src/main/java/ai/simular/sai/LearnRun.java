package ai.simular.sai;

import java.util.Map;

/**
 * One run of a learn job's code, from {@code sai.learn().rollout()}.
 *
 * @param run what the run returned and logged: {@code { result, logs, error, durationMs }}
 * @param judgement the judge's record of the run, when it was judged
 */
public record LearnRun(
    String learnId, int iteration, int rollout, Map<String, Object> run, Map<String, Object> judgement,
    Map<String, Object> raw) {

  static LearnRun parse(Map<String, Object> d) {
    return new LearnRun(
        Json.str(d.get("learnId"), ""),
        Json.integer(d.get("iteration")),
        Json.integer(d.get("rollout")),
        Json.obj(d.get("run")),
        Json.truthy(d.get("judgement")) ? Json.obj(d.get("judgement")) : null,
        d);
  }
}
