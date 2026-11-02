package ai.simular.sai;

import java.time.Duration;
import java.util.List;
import java.util.Map;

/** Options for {@code sai.learn().create()}. */
public final class LearnOptions {
  String taskTemplate;
  String template;
  Map<String, ?> inputs;
  String initialCode;
  List<Evaluation> evaluations;
  String guidance;
  String feedback;
  String history;
  Boolean runsWithoutReset;
  Integer maxIterations;
  Integer rollouts;
  String machine;
  Object criteria;
  Map<String, ?> reset;
  Boolean judgeInitialAgentRun;
  Boolean continueWithAgent;
  Integer rolloutMinutes;
  Integer agentRunMinutes;
  Integer continuationMinutes;
  Integer maxJobMinutes;
  String model;
  String idempotencyKey;
  Duration timeout;

  /**
   * The task, with {@code {{name}}} placeholders. Without turns, the agent does this task first.
   * With turns, it defaults to the first turn's.
   */
  public LearnOptions taskTemplate(String taskTemplate) {
    this.taskTemplate = taskTemplate;
    return this;
  }

  /** @deprecated Use {@link #taskTemplate(String)}. */
  @Deprecated
  public LearnOptions template(String template) {
    this.template = template;
    return this;
  }

  /** A value for every placeholder; with turns, defaults to the first turn's. */
  public LearnOptions inputs(Map<String, ?> inputs) {
    this.inputs = inputs;
    return this;
  }

  /** Code to repair (with {@code maxIterations} 0), or to start the run-judge-repair loop from. */
  public LearnOptions initialCode(String initialCode) {
    this.initialCode = initialCode;
    return this;
  }

  /** How {@code initialCode} did on runs (a repair only). */
  public LearnOptions evaluations(List<Evaluation> evaluations) {
    this.evaluations = evaluations;
    return this;
  }

  /** What you know about the task, for writing and repairing the code. */
  public LearnOptions guidance(String guidance) {
    this.guidance = guidance;
    return this;
  }

  /** @deprecated Use {@link #guidance(String)}. */
  @Deprecated
  public LearnOptions feedback(String feedback) {
    this.feedback = feedback;
    return this;
  }

  /** For a repair: what earlier versions of the code changed and how they failed. */
  public LearnOptions history(String history) {
    this.history = history;
    return this;
  }

  /**
   * For a conversion: the code will be run again and again with no reset in between, so it opens
   * the app or URL itself instead of assuming the screen it starts on.
   */
  public LearnOptions runsWithoutReset(boolean runsWithoutReset) {
    this.runsWithoutReset = runsWithoutReset;
    return this;
  }

  /** Code versions to run, judge and repair: 0 (the default) only writes the code. At most 5. */
  public LearnOptions maxIterations(int maxIterations) {
    this.maxIterations = maxIterations;
    return this;
  }

  /** Runs per code version; a version passes when all of them pass. Default 3, at most 5. */
  public LearnOptions rollouts(int rollouts) {
    this.rollouts = rollouts;
    return this;
  }

  /** The machine to run on; optional with one machine. */
  public LearnOptions machine(String machineId) {
    this.machine = machineId;
    return this;
  }

  public LearnOptions machine(Machine machine) {
    this.machine = machine.id();
    return this;
  }

  /** What "done" means for the judge; default: the task as written, with its inputs. */
  public LearnOptions criteria(String guideline) {
    this.criteria = guideline;
    return this;
  }

  public LearnOptions criteria(List<Check> checks) {
    this.criteria = checks;
    return this;
  }

  /**
   * Run before the agent run and before every run of the code: {@code Map.of("code", "...")} for
   * Simulang, or {@code Map.of("task", "...")} for the agent.
   */
  public LearnOptions reset(Map<String, ?> reset) {
    this.reset = reset;
    return this;
  }

  /** Judge the agent run first; if it fails, the job stops with the judgement and writes no code. */
  public LearnOptions judgeInitialAgentRun(boolean judgeInitialAgentRun) {
    this.judgeInitialAgentRun = judgeInitialAgentRun;
    return this;
  }

  /** After a failed run, let the agent finish the task; its turn feeds the repair. */
  public LearnOptions continueWithAgent(boolean continueWithAgent) {
    this.continueWithAgent = continueWithAgent;
    return this;
  }

  /** Limit of each run of the code, in minutes. Default 15. */
  public LearnOptions rolloutMinutes(int rolloutMinutes) {
    this.rolloutMinutes = rolloutMinutes;
    return this;
  }

  /** Limit of the agent run and of each reset task, in minutes. Default 15. */
  public LearnOptions agentRunMinutes(int agentRunMinutes) {
    this.agentRunMinutes = agentRunMinutes;
    return this;
  }

  /** Limit of each continuation, in minutes. Default 15. */
  public LearnOptions continuationMinutes(int continuationMinutes) {
    this.continuationMinutes = continuationMinutes;
    return this;
  }

  /** Limit of the whole job, in minutes. Default 615, at most 690. */
  public LearnOptions maxJobMinutes(int maxJobMinutes) {
    this.maxJobMinutes = maxJobMinutes;
    return this;
  }

  /** A model id from {@code sai.models().list()}; without it, Sai picks the model. */
  public LearnOptions model(String model) {
    this.model = model;
    return this;
  }

  /** The same key again returns the earlier result and runs nothing. */
  public LearnOptions idempotencyKey(String idempotencyKey) {
    this.idempotencyKey = idempotencyKey;
    return this;
  }

  /** The request's timeout. Default 10 minutes. */
  public LearnOptions timeout(Duration timeout) {
    this.timeout = timeout;
    return this;
  }
}
