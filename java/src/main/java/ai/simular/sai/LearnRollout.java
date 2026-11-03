package ai.simular.sai;

import java.util.Map;

/**
 * One run of a version of the code in a learn job.
 *
 * @param verdict {@code passed}, {@code failed}, {@code error} (the run could not be judged), {@code
 *     stopped} (the job stopped during this run), or null while the run is going
 * @param summary the judge's summary
 * @param continuationTurnId with {@code continueWithAgent}, the agent's turn after this failed run
 */
public record LearnRollout(
    int index,
    String verdict,
    LearnReset reset,
    String error,
    Map<String, Object> result,
    Long durationMs,
    String judgementId,
    String summary,
    String continuationTurnId,
    boolean continuationTimedOut) {}
