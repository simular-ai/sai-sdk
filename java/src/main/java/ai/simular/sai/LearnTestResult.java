package ai.simular.sai;

import java.util.Map;

/**
 * How the returned code did when it was run, on {@code inputs} only.
 *
 * @param status {@code not_judged} (not run all its runs), {@code passed} (passed every run) or
 *     {@code failed} (a run failed)
 */
public record LearnTestResult(String status, int passedRuns, int requiredRuns, Map<String, Object> inputs) {}
