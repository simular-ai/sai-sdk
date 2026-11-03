package ai.simular.sai;

/**
 * The verdict on one criterion of a judgement.
 *
 * @param id the check's id; null for a natural-language criteria
 * @param verdict {@code passed}, {@code failed} or {@code unverifiable} (the record cannot show it)
 */
public record CriterionResult(String id, String check, String verdict, Double score, String evidence) {}
