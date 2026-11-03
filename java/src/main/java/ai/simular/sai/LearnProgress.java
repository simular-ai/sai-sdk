package ai.simular.sai;

/** While a learn job runs: the step it is on. */
public record LearnProgress(String step, Integer iteration, Integer rollout) {}
