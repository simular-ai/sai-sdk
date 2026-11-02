package ai.simular.sai;

import java.util.Map;

/**
 * A one-hour token that acts as a Tenant.
 *
 * @param token pass as {@code Sai.builder().apiKey(token)} to act as the Tenant
 * @param expiresAt Unix time in milliseconds, an hour after the exchange; exchange again then
 */
public record TenantToken(String token, long expiresAt, String tenantId, Map<String, Object> raw) {
  static TenantToken parse(Map<String, Object> d) {
    return new TenantToken(
        Json.str(d.get("token"), ""),
        Json.lng(d.get("expiresAt")),
        Json.str(d.get("tenantId"), ""),
        d);
  }
}
