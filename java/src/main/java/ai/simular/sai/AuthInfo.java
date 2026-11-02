package ai.simular.sai;

import java.util.Map;

/**
 * Who the key or token acts as: {@code GET /v1/agents/auth}.
 *
 * @param authType {@code apiKey} for a key, {@code firebase} for a signed-in session or a Tenant
 *     token
 * @param tenantId set when the credential is a Tenant token
 */
public record AuthInfo(String userId, String authType, String tenantId, String orgId, Map<String, Object> raw) {
  static AuthInfo parse(Map<String, Object> d) {
    return new AuthInfo(
        Json.str(d.get("userId"), ""),
        Json.str(d.get("authType"), ""),
        Json.str(d.get("tenantId")),
        Json.str(d.get("orgId")),
        d);
  }
}
