package ai.simular.sai;

import java.util.Map;

/**
 * The account's plan and spendable credit, from {@code sai.account().get()}.
 *
 * @param creditsUsd spendable credit in USD; null on the unlimited plan or when billing could not
 *     be reached
 */
public record Account(
    String userId,
    String planId,
    String planTitle,
    boolean free,
    boolean unlimited,
    Double creditsUsd,
    Map<String, Object> raw) {

  static Account parse(Map<String, Object> d) {
    Map<String, Object> plan = Json.obj(d.get("plan"));
    Map<String, Object> credits = Json.obj(d.get("credits"));
    return new Account(
        Json.str(d.get("userId"), ""),
        Json.str(plan.get("id")),
        Json.str(plan.get("title"), ""),
        Json.truthy(plan.get("free")),
        Json.truthy(plan.get("unlimited")),
        Json.numOrNull(credits.get("usd")),
        d);
  }
}
