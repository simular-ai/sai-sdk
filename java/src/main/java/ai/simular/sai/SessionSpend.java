package ai.simular.sai;

/**
 * What one of a Tenant's sessions spent on AI calls in a date range.
 *
 * @param title null when the session has no title
 * @param costUsd in US dollars, not rounded to cents
 * @param firstDay the UTC day ({@code YYYY-MM-DD}) the session's spend was first counted, over its
 *     whole life
 */
public record SessionSpend(
    String sessionId, String title, double costUsd, long modelCalls, String firstDay, String lastDay) {}
