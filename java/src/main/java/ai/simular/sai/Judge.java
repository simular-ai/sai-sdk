package ai.simular.sai;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Judge recorded turns against criteria you choose now (research preview). */
public final class Judge {
  private static final Duration JUDGE_TIMEOUT = Duration.ofMinutes(3);

  private final Http http;

  Judge(Http http) {
    this.http = http;
  }

  /**
   * Judge recorded {@code turns} (one session, as one task) against a sentence for a model to
   * judge. Nothing runs again, and the turns do not change.
   */
  public Judgement create(List<?> turns, String criteria) {
    return send(turns, criteria, null);
  }

  public Judgement create(List<?> turns, String criteria, JudgeOptions opts) {
    return send(turns, criteria, opts);
  }

  /** Judge recorded {@code turns} against yes/no checks. */
  public Judgement create(List<?> turns, List<Check> criteria) {
    return send(turns, criteria, null);
  }

  public Judgement create(List<?> turns, List<Check> criteria, JudgeOptions opts) {
    return send(turns, criteria, opts);
  }

  public Judgement get(String judgementId) {
    return Judgement.parse(http.object("GET", "/v1/agents/judge/" + Http.encode(judgementId)));
  }

  private Judgement send(List<?> turns, Object criteria, JudgeOptions opts) {
    JudgeOptions o = opts == null ? new JudgeOptions() : opts;
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("turns", Learn.turnIds(turns));
    body.put("criteria", Check.criteria(criteria));
    if (o.task != null) body.put("task", o.task);
    if (o.idempotencyKey != null) body.put("idempotency_key", o.idempotencyKey);
    return Judgement.parse(
        http.object("POST", "/v1/agents/judge",
            Http.Req.json(body).timeout(o.timeout != null ? o.timeout : JUDGE_TIMEOUT)));
  }
}
