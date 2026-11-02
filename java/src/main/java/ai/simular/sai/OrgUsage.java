package ai.simular.sai;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/** What an Organisation is charged, per Tenant, from {@code sai.usage().get()}. */
public record OrgUsage(
    String granularity, String from, String to, UsageBucket totals, List<UsageBucket> buckets,
    Map<String, Object> raw) {

  static OrgUsage parse(Map<String, Object> d) {
    List<UsageBucket> buckets = new ArrayList<>();
    for (Object b : Json.list(d.get("buckets"))) buckets.add(UsageBucket.parse(Json.obj(b)));
    return new OrgUsage(
        Json.str(d.get("granularity"), ""),
        Json.str(d.get("from"), ""),
        Json.str(d.get("to"), ""),
        UsageBucket.parse(Json.obj(d.get("totals"))),
        Collections.unmodifiableList(buckets),
        d);
  }
}
