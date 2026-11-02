package ai.simular.sai;

import java.util.Map;

/**
 * A single-use code that enrolls one computer into a Tenant.
 *
 * @param token treat it as a secret until the Sai runtime redeems it
 * @param expiresAt Unix time in milliseconds, 15 minutes after it was created
 */
public record Enrollment(String token, long expiresAt, Map<String, Object> raw) {
  static Enrollment parse(Map<String, Object> d) {
    return new Enrollment(Json.str(d.get("enrollmentToken"), ""), Json.lng(d.get("expiresAt")), d);
  }
}
