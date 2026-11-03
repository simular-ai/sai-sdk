package ai.simular.sai;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * One page of {@code sai.usage().sessions()}. A page can be empty and still have a {@code
 * nextCursor}.
 *
 * @param nextCursor pass as {@code cursor} for the next page; null on the last page
 * @param dataThrough ISO 8601: the figures are complete up to this time; null when unknown
 */
public record SessionSpendPage(
    List<SessionSpend> sessions, String nextCursor, String dataThrough, Map<String, Object> raw) {

  static SessionSpendPage parse(Map<String, Object> d) {
    List<SessionSpend> sessions = new ArrayList<>();
    for (Object x : Json.list(d.get("sessions"))) {
      Map<String, Object> s = Json.obj(x);
      String title = Json.str(s.get("title"));
      sessions.add(
          new SessionSpend(
              Json.str(s.get("sessionId"), ""),
              title == null || title.isEmpty() ? null : title,
              Json.num(s.get("costUsd")),
              Json.lng(s.get("modelCalls")),
              Json.str(s.get("firstDay"), ""),
              Json.str(s.get("lastDay"), "")));
    }
    return new SessionSpendPage(
        Collections.unmodifiableList(sessions), Json.str(d.get("nextCursor")), Json.str(d.get("dataThrough")), d);
  }
}
