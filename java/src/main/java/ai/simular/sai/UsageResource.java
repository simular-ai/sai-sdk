package ai.simular.sai;

import java.util.LinkedHashMap;
import java.util.Map;

/** What an Organisation is charged, per Tenant and per session. Takes an Organisation Key. */
public final class UsageResource {
  private final Http http;
  private final String orgId;

  UsageResource(Http http, String orgId) {
    this.http = http;
    this.orgId = orgId;
  }

  public OrgUsage get() {
    return get(new UsageOptions());
  }

  /** What the Organisation is charged, in total and per Tenant, per {@code granularity}. */
  public OrgUsage get(UsageOptions opts) {
    UsageOptions o = opts == null ? new UsageOptions() : opts;
    Map<String, Object> params = new LinkedHashMap<>();
    params.put("granularity", o.granularity);
    params.put("from", o.from);
    params.put("to", o.to);
    return OrgUsage.parse(
        http.object("GET", "/v1/orgs/" + Http.encode(org(o.orgId)) + "/usage", Http.Req.params(params)));
  }

  public SessionSpendPage sessions(String tenantId, String from, String to) {
    return sessions(tenantId, from, to, null);
  }

  /**
   * One page of what each of a Tenant's sessions spent on AI calls, oldest first, for the UTC days
   * {@code from} to {@code to} ({@code YYYY-MM-DD}, both included, at most 93 days). Keep paging
   * with {@code nextCursor} until it is null: a page can be empty and not be the last.
   *
   * <p>With {@link SessionSpendOptions#sessionIds} instead of the range, see {@link
   * #sessions(String, SessionSpendOptions)}.
   */
  public SessionSpendPage sessions(String tenantId, String from, String to, SessionSpendOptions opts) {
    SessionSpendOptions o = opts == null ? new SessionSpendOptions() : opts;
    Map<String, Object> params = new LinkedHashMap<>();
    params.put("tenantId", tenantId);
    params.put("from", from);
    params.put("to", to);
    params.put("limit", o.limit);
    params.put("cursor", o.cursor);
    params.put("sessionIds", o.sessionIds == null || o.sessionIds.isEmpty() ? null : String.join(",", o.sessionIds));
    return SessionSpendPage.parse(
        http.object("GET", "/v1/orgs/" + Http.encode(org(o.orgId)) + "/usage/sessions", Http.Req.params(params)));
  }

  public SessionSpendPage sessions(Tenant tenant, String from, String to) {
    return sessions(tenant.id(), from, to, null);
  }

  public SessionSpendPage sessions(Tenant tenant, String from, String to, SessionSpendOptions opts) {
    return sessions(tenant.id(), from, to, opts);
  }

  /**
   * Without a date range: with {@link SessionSpendOptions#sessionIds} (1 to 50), the named
   * sessions' spend right now, each with {@code settled}, and the page's {@code asOf}; no paging.
   * Charge for a task once its session is settled.
   */
  public SessionSpendPage sessions(String tenantId, SessionSpendOptions opts) {
    return sessions(tenantId, null, null, opts);
  }

  public SessionSpendPage sessions(Tenant tenant, SessionSpendOptions opts) {
    return sessions(tenant.id(), null, null, opts);
  }

  private String org(String override) {
    String id = override != null ? override : orgId;
    if (id == null || id.isEmpty()) {
      throw new IllegalStateException(
          "No Organisation id: pass orgId here or to Sai.builder(), or set SAI_ORG_ID.");
    }
    return id;
  }
}
