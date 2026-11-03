package ai.simular.sai;

import java.util.Map;

/**
 * A session on a computer, from {@code sai.sessions().list()}.
 *
 * @param updatedAt Unix time in milliseconds
 * @param active the session the next message on this computer goes to
 */
public record SessionSummary(String id, String title, long updatedAt, boolean active, Map<String, Object> raw) {
  static SessionSummary parse(Map<String, Object> d) {
    return new SessionSummary(
        Json.str(d.get("sessionId"), ""),
        Json.str(d.get("title"), ""),
        Json.lng(d.get("updatedAt")),
        Json.truthy(d.get("active")),
        d);
  }
}
