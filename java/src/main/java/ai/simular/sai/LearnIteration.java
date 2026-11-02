package ai.simular.sai;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * One version of the code in a learn job and its runs.
 *
 * @param index 1-based
 * @param learnId the convert or heal record that wrote this version ({@code sai.learn().get()})
 * @param changes what the repair changed and why
 */
public record LearnIteration(
    int index, String learnId, String changes, int passed, int runs, List<LearnRollout> rollouts) {

  static LearnIteration parse(Map<String, Object> d) {
    List<LearnRollout> rollouts = new ArrayList<>();
    for (Map<String, Object> r : Json.objects(d.get("rollouts"))) {
      rollouts.add(
          new LearnRollout(
              Json.integer(r.get("index")),
              Json.str(r.get("verdict")),
              LearnReset.parse(r.get("reset")),
              Json.str(r.get("error")),
              Json.objOrNull(r.get("result")),
              Json.lngOrNull(r.get("durationMs")),
              Json.str(r.get("judgementId")),
              Json.str(r.get("summary")),
              Json.str(r.get("continuationTurnId")),
              Json.truthy(r.get("continuationTimedOut"))));
    }
    return new LearnIteration(
        Json.integer(d.get("index")),
        Json.str(d.get("learnId")),
        Json.str(d.get("changes")),
        Json.integer(d.get("passed")),
        Json.integer(d.get("runs")),
        Collections.unmodifiableList(rollouts));
  }
}
