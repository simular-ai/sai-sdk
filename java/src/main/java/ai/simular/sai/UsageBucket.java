package ai.simular.sai;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One period of an Organisation usage report, or the whole range ({@code totals}).
 *
 * @param bucket the period, e.g. {@code 2026-10}; null on {@code totals}
 * @param byTenant keyed by Tenant id. Spend tied to no Tenant is in {@code costCents} only.
 */
public record UsageBucket(String bucket, long costCents, Map<String, TenantUsage> byTenant) {
  static UsageBucket parse(Map<String, Object> d) {
    Map<String, TenantUsage> byTenant = new LinkedHashMap<>();
    for (Map.Entry<String, Object> e : Json.obj(d.get("byTenant")).entrySet()) {
      Map<String, Object> t = Json.obj(e.getValue());
      Map<String, CategoryUsage> byCategory = new LinkedHashMap<>();
      for (Map.Entry<String, Object> c : Json.obj(t.get("byCategory")).entrySet()) {
        byCategory.put(c.getKey(), new CategoryUsage(Json.lng(Json.obj(c.getValue()).get("costCents"))));
      }
      byTenant.put(
          e.getKey(),
          new TenantUsage(
              Json.str(t.get("tenantId"), e.getKey()),
              Json.str(t.get("name")),
              Json.str(t.get("externalId")),
              Json.lng(t.get("costCents")),
              Collections.unmodifiableMap(byCategory)));
    }
    return new UsageBucket(
        Json.str(d.get("bucket")), Json.lng(d.get("costCents")), Collections.unmodifiableMap(byTenant));
  }
}
