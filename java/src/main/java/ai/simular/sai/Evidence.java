package ai.simular.sai;

/**
 * The verdict on one success criterion.
 *
 * @param id the check's id; null for a natural-language criteria
 * @param score the probability that the check holds ({@link Check} criteria only)
 * @param evidence always for a natural-language criteria; for a {@link Check}, only with {@code
 *     returnEvidence}
 */
public record Evidence(String id, boolean passed, Double score, String evidence) {}
