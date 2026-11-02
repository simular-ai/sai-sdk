package ai.simular.sai;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * The result of {@code sai.judge().create()}. It never changes the turns it judged. Research
 * preview.
 *
 * @param verdict {@code passed}, {@code failed}, {@code unverifiable}, or null
 */
public record Judgement(
    String id,
    String verdict,
    String summary,
    String task,
    List<CriterionResult> criteria,
    List<String> turns,
    Usage usage,
    boolean replayed,
    boolean ok,
    Map<String, Object> raw) {

  static Judgement parse(Map<String, Object> d) {
    String verdict = Json.str(d.get("verdict"));
    List<CriterionResult> criteria = new ArrayList<>();
    for (Map<String, Object> c : Json.objects(d.get("criteria"))) {
      criteria.add(
          new CriterionResult(
              Json.str(c.get("id")),
              Json.str(c.get("check"), ""),
              Json.str(c.get("verdict"), "unverifiable"),
              Json.numOrNull(c.get("score")),
              Json.str(c.get("evidence"))));
    }
    return new Judgement(
        Json.str(d.get("judgementId"), ""),
        verdict,
        Json.str(d.get("summary")),
        Json.str(d.get("task")),
        Collections.unmodifiableList(criteria),
        Json.strings(d.get("turns")),
        Usage.parse(d.get("usage")),
        Json.truthy(d.get("idempotent_replay")),
        "passed".equals(verdict),
        d);
  }
}
