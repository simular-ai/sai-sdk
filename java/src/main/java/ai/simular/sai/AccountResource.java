package ai.simular.sai;

/** The account the key belongs to. */
public final class AccountResource {
  private final Http http;

  AccountResource(Http http) {
    this.http = http;
  }

  /** Plan and spendable credit. Slow-ish (billing lookup): not for a poll loop. */
  public Account get() {
    return Account.parse(http.object("GET", "/v1/agents/account"));
  }
}
