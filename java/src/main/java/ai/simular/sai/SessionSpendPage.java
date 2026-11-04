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
 * @param dataThrough ISO 8601: the figures are complete up to this time; null when unknown, and
 *     from a {@code sessionIds} lookup
 * @param asOf ISO 8601, from a {@code sessionIds} lookup: when the figures were read; null on a
 *     list page
 */
public record SessionSpendPage(
    List<SessionSpend> sessions,
    String nextCursor,
    String dataThrough,
    String asOf,
    Map<String, Object> raw) {

  static SessionSpendPage parse(Map<String, Object> d) {
    List<SessionSpend> sessions = new ArrayList<>();
    for (Object x : Json.list(d.get("sessions"))) {
      Map<String, Object> s = Json.obj(x);
      String title = Json.str(s.get("title"));
      sessions.add(
          new SessionSpend(
              Json.str(s.get("sessionId"), ""),
              title == null || title.isEmpty() ? null : title,
              Json.numOrNull(s.get("costUsd")),
              Json.lngOrNull(s.get("modelCalls")),
              Json.str(s.get("firstDay"), ""),
              Json.str(s.get("lastDay"), ""),
              s.get("settled") instanceof Boolean b ? b : null));
    }
    return new SessionSpendPage(
        Collections.unmodifiableList(sessions),
        Json.str(d.get("nextCursor")),
        Json.str(d.get("dataThrough")),
        Json.str(d.get("asOf")),
        d);
  }
}
