package ai.simular.sai;

/**
 * What one of a Tenant's sessions spent on AI calls: in a date range, or so far when looked up by
 * {@link SessionSpendOptions#sessionIds}.
 *
 * @param title null when the session has no title
 * @param costUsd in US dollars, not rounded to cents. Null only from a {@code sessionIds} lookup,
 *     when the session can't be read in full right now (never 0 for that); {@code settled} is then
 *     false
 * @param modelCalls null together with {@code costUsd}
 * @param firstDay the UTC day ({@code YYYY-MM-DD}) the session's spend was first counted, over its
 *     whole life; empty from a {@code sessionIds} lookup
 * @param settled from a {@code sessionIds} lookup: true once the session's latest task has ended
 *     and every charge for it has come in; null on a list page
 */
public record SessionSpend(
    String sessionId,
    String title,
    Double costUsd,
    Long modelCalls,
    String firstDay,
    String lastDay,
    Boolean settled) {}
