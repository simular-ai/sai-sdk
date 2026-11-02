package ai.simular.sai;

/** Who the key acts as. */
public final class Auth {
  private final Http http;

  Auth(Http http) {
    this.http = http;
  }

  /** Who the key or token acts as. Throws {@link AuthenticationException} for a missing or revoked key. */
  public AuthInfo check() {
    return AuthInfo.parse(http.object("GET", "/v1/agents/auth"));
  }
}
