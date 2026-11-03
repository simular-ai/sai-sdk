package ai.simular.sai;

import java.util.List;
import java.util.Map;

/**
 * Sai is waiting for permission (or for an answer to a choice question).
 *
 * @param type {@code exec}, {@code choice}, ...; a {@code choice} needs {@code selections} when
 *     approved
 * @param isLinkOnly true: a human must answer in a browser at {@code url}; the API cannot
 */
public record Approval(
    String id,
    String title,
    String description,
    String type,
    boolean isLinkOnly,
    String url,
    String command,
    List<Map<String, Object>> questions,
    Map<String, Object> raw) {

  static Approval parse(Map<String, Object> d) {
    return new Approval(
        Json.str(d.get("approvalId"), ""),
        Json.str(d.get("title"), ""),
        Json.str(d.get("description"), ""),
        Json.str(d.get("approvalType"), ""),
        Json.truthy(d.get("isLinkOnly")),
        Json.str(d.get("approvalUrl")),
        Json.str(d.get("command")),
        Json.objects(d.get("questions")),
        d);
  }
}
