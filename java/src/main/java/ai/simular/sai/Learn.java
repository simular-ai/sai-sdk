package ai.simular.sai;

import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Learn (research preview): turn recorded turns, or a task the agent does first, into Simulang code
 * you own; repair that code; run, judge and repair it on a machine until it passes (policy
 * iteration). Maps to {@code /v1/agents/learn}.
 */
public final class Learn {
  /** A conversion is two model calls of up to a minute or two each, plus one retry. */
  private static final Duration LEARN_TIMEOUT = Duration.ofMinutes(10);
  /** How often {@code waitFor} reads a learn job; a job's steps take tens of seconds to minutes. */
  private static final Duration LEARN_POLL_INTERVAL = Duration.ofSeconds(10);

  private final Http http;

  Learn(Http http) {
    this.http = http;
  }

  public LearnResult create(List<?> turns) {
    return create(turns, new LearnOptions());
  }

  /**
   * Make Simulang code, and optionally run, judge and repair it on a machine.
   *
   * <ul>
   *   <li>{@code create(turns)}: code from recorded turns (ordered, one session, each sent with
   *       {@code recordTrajectory}). Answers with the code.
   *   <li>{@code create(List.of(), opts.initialCode(...).guidance(...))}: a repair.
   *   <li>{@code create(turns, opts.maxIterations(3))} or {@code create(List.of(),
   *       opts.taskTemplate(...).inputs(...).maxIterations(3))}: a job on the machine. Answers at
   *       once with status {@code running}; read it with {@code waitFor()}.
   * </ul>
   *
   * {@code turns} holds turn ids, {@link Turn}s or {@link TurnRecord}s. A result with {@code
   * validation.errors} comes back failed.
   */
  public LearnResult create(List<?> turns, LearnOptions opts) {
    LearnOptions o = opts == null ? new LearnOptions() : opts;
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("turns", turnIds(turns));
    // The old names go out as sent, so code that uses them keeps working with an older API.
    if (o.taskTemplate != null) body.put("taskTemplate", o.taskTemplate);
    else if (o.template != null) body.put("template", o.template);
    if (o.inputs != null) body.put("inputs", o.inputs);
    if (o.initialCode != null) body.put("initialCode", o.initialCode);
    if (o.evaluations != null) {
      List<Object> evals = new ArrayList<>();
      for (Evaluation e : o.evaluations) evals.add(e.toJson());
      body.put("evaluations", evals);
    }
    if (o.guidance != null) body.put("guidance", o.guidance);
    else if (o.feedback != null) body.put("feedback", o.feedback);
    if (o.machine != null) body.put("machineId", o.machine);
    putIf(body, "history", o.history);
    putIf(body, "runsWithoutReset", o.runsWithoutReset);
    putIf(body, "maxIterations", o.maxIterations);
    putIf(body, "rollouts", o.rollouts);
    putIf(body, "criteria", o.criteria == null ? null : Check.criteria(o.criteria));
    putIf(body, "reset", o.reset);
    putIf(body, "judgeInitialAgentRun", o.judgeInitialAgentRun);
    putIf(body, "continueWithAgent", o.continueWithAgent);
    putIf(body, "rolloutMinutes", o.rolloutMinutes);
    putIf(body, "agentRunMinutes", o.agentRunMinutes);
    putIf(body, "continuationMinutes", o.continuationMinutes);
    putIf(body, "maxJobMinutes", o.maxJobMinutes);
    putIf(body, "model", o.model);
    putIf(body, "idempotency_key", o.idempotencyKey);
    return LearnResult.parse(
        http.object("POST", "/v1/agents/learn",
            Http.Req.json(body).timeout(o.timeout != null ? o.timeout : LEARN_TIMEOUT)));
  }

  /** A learn call's result, or a job's progress so far. */
  public LearnResult get(String learnId) {
    return LearnResult.parse(http.object("GET", "/v1/agents/learn/" + Http.encode(learnId)));
  }

  public LearnResult waitFor(String learnId) {
    return waitFor(learnId, null, null);
  }

  public LearnResult waitFor(LearnResult job) {
    return waitFor(job.id(), null, null);
  }

  public LearnResult waitFor(LearnResult job, Duration timeout, Duration pollInterval) {
    return waitFor(job.id(), timeout, pollInterval);
  }

  /**
   * Read a learn job until it ends ({@code succeeded}, {@code failed} or {@code stopped}), every
   * {@code pollInterval} (null: 10 s). {@code timeout} (null: none) throws {@link
   * SaiTimeoutException} with the job still running; it keeps running.
   */
  public LearnResult waitFor(String learnId, Duration timeout, Duration pollInterval) {
    long poll = (pollInterval != null ? pollInterval : LEARN_POLL_INTERVAL).toMillis();
    Long deadline = timeout == null ? null : System.currentTimeMillis() + timeout.toMillis();
    for (;;) {
      LearnResult r;
      try {
        r = get(learnId);
      } catch (RateLimitException e) {
        Sleep.retryAfter(e);
        continue;
      }
      if (!"running".equals(r.status())) return r;
      if (deadline != null && System.currentTimeMillis() + poll > deadline) {
        throw new SaiTimeoutException("Learn job " + learnId + " is still running.");
      }
      Sleep.millis(poll);
    }
  }

  /**
   * Stop a learn job at once, whatever step it is on. It keeps the last complete results and reads
   * {@code stopped} / {@code cancelled} once it has ended, normally within seconds.
   */
  public void cancel(String learnId) {
    http.json("POST", "/v1/agents/learn/" + Http.encode(learnId) + "/cancel", null);
  }

  public void cancel(LearnResult job) {
    cancel(job.id());
  }

  /** One run of a learn job's code: what it returned and logged, and its judgement. */
  public LearnRun rollout(String learnId, int iteration, int rollout) {
    return LearnRun.parse(
        http.object("GET",
            "/v1/agents/learn/" + Http.encode(learnId) + "/iterations/" + iteration + "/rollouts/" + rollout));
  }

  public LearnRun rollout(LearnResult job, int iteration, int rollout) {
    return rollout(job.id(), iteration, rollout);
  }

  static List<String> turnIds(List<?> turns) {
    List<String> ids = new ArrayList<>();
    for (Object t : turns) ids.add(TurnRef.idOf(t));
    return ids;
  }

  private static void putIf(Map<String, Object> body, String key, Object value) {
    if (value != null) body.put(key, value);
  }
}
