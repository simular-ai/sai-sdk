package ai.simular.sai;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** How learned code did on one run, for {@code LearnOptions.evaluations()}. */
public final class Evaluation {
  /** The last log lines of a run sent with an evaluation; the API takes 20 KB per result. */
  private static final int EVAL_LOG_LINES = 30;

  private final Map<String, ?> inputs;
  private ExecResult result;
  private Object judgement;
  private Boolean passed;
  private String note;

  /** A run on these inputs. */
  public Evaluation(Map<String, ?> inputs) {
    this.inputs = inputs;
  }

  /** The run's result from {@code lease.exec()} / {@code lease.run()}; its screenshot is not sent. */
  public Evaluation result(ExecResult result) {
    this.result = result;
    return this;
  }

  /** A judgement of the run. */
  public Evaluation judgement(Judgement judgement) {
    this.judgement = judgement;
    return this;
  }

  /** A judgement of the run, by id. */
  public Evaluation judgement(String judgementId) {
    this.judgement = judgementId;
    return this;
  }

  public Evaluation passed(boolean passed) {
    this.passed = passed;
    return this;
  }

  public Evaluation note(String note) {
    this.note = note;
    return this;
  }

  Map<String, Object> toJson() {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("inputs", inputs);
    if (result != null) {
      Map<String, Object> r = new LinkedHashMap<>();
      r.put("result", result.result());
      List<String> logs = result.logs();
      r.put("logs", logs.subList(Math.max(0, logs.size() - EVAL_LOG_LINES), logs.size()));
      if (result.error() != null) {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("kind", result.error().kind());
        e.put("message", result.error().message());
        r.put("error", e);
      }
      m.put("result", r);
    }
    if (judgement != null) {
      m.put("judgement", judgement instanceof Judgement j ? j.id() : judgement);
    }
    if (passed != null) m.put("passed", passed);
    if (note != null) m.put("note", note);
    return m;
  }
}
