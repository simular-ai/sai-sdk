package ai.simular.sai;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * The result of {@code sai.learn().create()}: Simulang code made from recorded turns or from an
 * agent run, a repair of code you sent, or a learn job that runs, judges and repairs the code. Run
 * the code with {@code lease.run(learned, inputs)}. Research preview.
 *
 * @param mode {@code convert} (code from turns), {@code heal} (a repair of {@code initialCode}), or
 *     {@code policyIteration} (a job that runs the code)
 * @param status {@code running} while a job runs; {@code succeeded}; {@code failed} when it wrote no
 *     code (e.g. {@code validation.errors}); {@code stopped} when a job ended early. How the code
 *     did is {@code testResult}.
 * @param stopReason why a job ended early, e.g. {@code cancelled}, {@code time_limit}, {@code
 *     agent_failed}
 * @param agentTurnId a job's agent run; pass it as {@code turns} to start again from that run
 * @param version which iteration {@code code} is from
 * @param template the task with {@code {{name}}} placeholders
 * @param code {@code async function main(params = { ... })}
 * @param changes for {@code heal}: what changed and why
 * @param error the error code when the request failed, e.g. {@code trajectory_not_recorded}
 * @param replayed true when {@code idempotencyKey} matched an earlier call
 */
public record LearnResult(
    String id,
    String mode,
    String status,
    String stopReason,
    String message,
    LearnTestResult testResult,
    LearnProgress progress,
    String agentTurnId,
    LearnReset agentRunReset,
    AgentJudgement agentJudgement,
    Integer version,
    List<LearnIteration> iterations,
    String title,
    String template,
    List<LearnParameter> parameters,
    String code,
    Map<String, Object> outputSchema,
    LearnValidation validation,
    String changes,
    List<String> sourceTurns,
    Usage usage,
    String error,
    boolean replayed,
    boolean ok,
    Map<String, Object> raw) {

  static LearnResult parse(Map<String, Object> d) {
    Map<String, Object> v = Json.obj(d.get("validation"));
    String status = Json.str(d.get("status"), "running");
    String mode = Json.str(d.get("mode"));
    Map<String, Object> t = Json.truthy(d.get("testResult")) ? Json.obj(d.get("testResult")) : null;
    Map<String, Object> p = Json.truthy(d.get("progress")) ? Json.obj(d.get("progress")) : null;
    Map<String, Object> aj =
        Json.truthy(d.get("agentJudgement")) ? Json.obj(d.get("agentJudgement")) : null;
    List<LearnIteration> iterations = new ArrayList<>();
    for (Map<String, Object> i : Json.objects(d.get("iterations"))) iterations.add(LearnIteration.parse(i));
    List<LearnParameter> parameters = new ArrayList<>();
    for (Map<String, Object> x : Json.objects(d.get("parameters"))) {
      parameters.add(
          new LearnParameter(
              Json.str(x.get("name"), ""),
              Json.str(x.get("defaultValue"), ""),
              Json.str(x.get("description"))));
    }
    return new LearnResult(
        Json.str(d.get("learnId"), ""),
        "heal".equals(mode) || "policyIteration".equals(mode) ? mode : "convert",
        status,
        Json.str(d.get("stopReason")),
        Json.str(d.get("message")),
        t == null
            ? null
            : new LearnTestResult(
                Json.str(t.get("status"), "not_judged"),
                Json.integer(t.get("passedRuns")),
                Json.integer(t.get("requiredRuns")),
                Json.truthy(t.get("inputs")) ? Json.obj(t.get("inputs")) : null),
        p == null
            ? null
            : new LearnProgress(
                Json.str(p.get("step"), ""), Json.intOrNull(p.get("iteration")), Json.intOrNull(p.get("rollout"))),
        Json.str(d.get("agentTurnId")),
        LearnReset.parse(d.get("agentRunReset")),
        aj == null
            ? null
            : new AgentJudgement(
                Json.str(aj.get("judgementId"), ""), Json.str(aj.get("verdict"), ""), Json.str(aj.get("summary"))),
        Json.intOrNull(d.get("version")),
        Collections.unmodifiableList(iterations),
        Json.str(d.get("title")),
        Json.str(d.get("template")),
        Collections.unmodifiableList(parameters),
        Json.str(d.get("code"), ""),
        Json.truthy(d.get("outputSchema")) ? Json.obj(d.get("outputSchema")) : null,
        new LearnValidation(Json.strings(v.get("errors")), Json.strings(v.get("warnings"))),
        Json.str(d.get("changes")),
        Json.strings(d.get("sourceTurns")),
        Usage.parse(d.get("usage")),
        Json.str(d.get("error")),
        Json.truthy(d.get("idempotent_replay")),
        "succeeded".equals(status),
        d);
  }
}
