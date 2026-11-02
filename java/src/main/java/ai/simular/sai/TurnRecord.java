package ai.simular.sai;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * A turn's record. {@code status} is running, needs_input (an approval or question is pending),
 * finalizing (the agent is done; output and checks are being worked out), succeeded or failed. On
 * failed, {@code reasonCode} says why: {@code agent_error} (with {@code errorCode} when known),
 * {@code machine_unavailable}, {@code not_started}, and for a structured message {@code
 * output_invalid} (see {@code rawAnswer} and {@code outputErrors}), {@code criteria_not_met} or
 * {@code criteria_unchecked}.
 *
 * @param output the agent's final text; with {@code outputSchema}, an object matching it
 * @param errorCode {@code insufficient_credits} or {@code free_computer_time_exhausted}, for a
 *     known {@code agent_error}
 * @param evidence empty for a plain message
 * @param usage tokens of every model call the agent made in the turn
 * @param trajectoryRecorded at least one step was stored ({@code sai.turns().trajectory()})
 * @param replayed true when {@code idempotencyKey} matched an earlier turn: this is that turn
 */
public record TurnRecord(
    String id,
    String sessionId,
    String machineId,
    TurnRecordStatus status,
    Object output,
    String reasonCode,
    String rawAnswer,
    String errorCode,
    List<String> outputErrors,
    List<Evidence> evidence,
    Usage usage,
    boolean recordTrajectory,
    boolean trajectoryRecorded,
    String template,
    Map<String, Object> inputs,
    boolean replayed,
    boolean done,
    boolean ok,
    Map<String, Object> raw)
    implements TurnRef {

  static TurnRecord parse(Map<String, Object> d) {
    TurnRecordStatus status = TurnRecordStatus.of(Json.str(d.get("status"), "running"));
    List<Evidence> evidence = new ArrayList<>();
    for (Map<String, Object> e : Json.objects(d.get("evidence"))) {
      evidence.add(
          new Evidence(
              Json.str(e.get("id")),
              Json.truthy(e.get("passed")),
              Json.numOrNull(e.get("score")),
              Json.str(e.get("evidence"))));
    }
    return new TurnRecord(
        Json.str(d.get("turnId"), ""),
        Json.str(d.get("sessionId")),
        Json.str(d.get("machineId"), ""),
        status,
        d.get("output"),
        Json.str(d.get("reason_code")),
        Json.str(d.get("raw_answer")),
        Json.str(d.get("error_code")),
        Json.strings(d.get("output_errors")),
        Collections.unmodifiableList(evidence),
        Usage.parse(d.get("usage")),
        Json.truthy(d.get("recordTrajectory")),
        Json.truthy(Json.obj(d.get("trajectory")).get("recorded")),
        Json.str(d.get("template")),
        Json.objOrNull(d.get("inputs")),
        Json.truthy(d.get("idempotent_replay")),
        status == TurnRecordStatus.SUCCEEDED || status == TurnRecordStatus.FAILED,
        status == TurnRecordStatus.SUCCEEDED,
        d);
  }
}
