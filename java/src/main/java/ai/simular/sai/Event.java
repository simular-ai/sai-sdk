package ai.simular.sai;

import java.util.Map;

/**
 * One thing that happened in a turn. {@code kind} is the SDK's name; {@code type} is the wire type.
 *
 * @param code {@code insufficient_credits} / {@code free_computer_time_exhausted} on errors: stop
 *     retrying today
 */
public record Event(
    EventKind kind, String type, String text, Approval approval, String code, Map<String, Object> raw) {

  static Event parse(Map<String, Object> d) {
    String t = Json.str(d.get("type"), "");
    Map<String, Object> data = Json.obj(d.get("data"));
    String text = null;
    Approval approval = null;
    switch (t) {
      case "data-progress" -> text = Json.str(data.get("text"));
      case "text-delta", "reasoning-delta" -> text = Json.str(d.get("delta"));
      case "tool-output-error", "error" -> text = Json.str(d.get("errorText"));
      case "data-approval-request" -> {
        if (Json.truthy(data.get("approvalId"))) {
          approval = Approval.parse(data);
          text = approval.title();
        }
      }
      default -> {}
    }
    return new Event(EventKind.ofWireType(t), t, text, approval, Json.str(d.get("code")), d);
  }
}
