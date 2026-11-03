package ai.simular.sai;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.function.Supplier;

/** Tenants: your customers, under an Organisation. Every call takes an Organisation Key. */
public final class Tenants {
  /** {@code client()} exchanges again when its token has less than this left. */
  static final long TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

  private final Http http;
  private final String orgId;
  private final Function<Supplier<String>, Sai> withCredential;

  Tenants(Http http, String orgId, Function<Supplier<String>, Sai> withCredential) {
    this.http = http;
    this.orgId = orgId;
    this.withCredential = withCredential;
  }

  static String path(String tenantId) {
    return "/v1/tenants/" + Http.encode(tenantId);
  }

  public Tenant create(String name) {
    return create(name, null);
  }

  /** {@code externalId} is your id for the customer, unique in the Organisation; it cannot change. */
  public Tenant create(String name, CreateTenantOptions opts) {
    CreateTenantOptions o = opts == null ? new CreateTenantOptions() : opts;
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("name", name);
    if (o.externalId != null) body.put("externalId", o.externalId);
    if (o.metadata != null) body.put("metadata", o.metadata);
    return Tenant.parse(http.object("POST", "/v1/tenants", Http.Req.json(body)));
  }

  public TenantPage list() {
    return list(null);
  }

  /** One page, newest first. */
  public TenantPage list(ListTenantsOptions opts) {
    ListTenantsOptions o = opts == null ? new ListTenantsOptions() : opts;
    Map<String, Object> params = new LinkedHashMap<>();
    params.put("status", o.status);
    params.put("externalId", o.externalId);
    params.put("limit", o.limit);
    params.put("cursor", o.cursor);
    Map<String, Object> d = http.object("GET", "/v1/tenants", Http.Req.params(params));
    List<Tenant> tenants = new ArrayList<>();
    for (Map<String, Object> t : Json.objects(d.get("tenants"))) tenants.add(Tenant.parse(t));
    return new TenantPage(Collections.unmodifiableList(tenants), Json.str(d.get("nextCursor")));
  }

  public Tenant get(String tenantId) {
    return Tenant.parse(http.object("GET", path(tenantId)));
  }

  public Tenant get(Tenant tenant) {
    return get(tenant.id());
  }

  /**
   * Change a Tenant: {@code metadata} replaces the whole map; status {@code disabled} stops its
   * tokens and machines, {@code active} brings it back.
   */
  public Tenant update(String tenantId, UpdateTenantOptions changes) {
    return Tenant.parse(http.object("PATCH", path(tenantId), Http.Req.json(changes.body)));
  }

  public Tenant update(Tenant tenant, UpdateTenantOptions changes) {
    return update(tenant.id(), changes);
  }

  /**
   * Disables the Tenant and revokes every enrolled machine. Cloud machines stay and hibernate:
   * delete them with {@code tenantMachines().delete()}. Its data is kept.
   */
  public void delete(String tenantId) {
    http.request("DELETE", path(tenantId), null);
  }

  public void delete(Tenant tenant) {
    delete(tenant.id());
  }

  /** A single-use code that enrolls one computer into the Tenant. It expires in 15 minutes. */
  public Enrollment createEnrollment(String tenantId) {
    return Enrollment.parse(http.object("POST", path(tenantId) + "/enrollments"));
  }

  public Enrollment createEnrollment(Tenant tenant) {
    return createEnrollment(tenant.id());
  }

  public TenantToken token(String tenantId) {
    return token(tenantId, null);
  }

  /**
   * Exchange the Organisation Key for a one-hour token that acts as the Tenant. {@code orgId}
   * (null: the client's, {@code SAI_ORG_ID}) is the Tenant's Organisation.
   */
  public TenantToken token(String tenantId, String orgId) {
    String org = orgId != null ? orgId : this.orgId;
    if (org == null || org.isEmpty()) {
      throw new IllegalStateException(
          "No Organisation id: pass orgId here or to Sai.builder(), or set SAI_ORG_ID.");
    }
    return TenantToken.parse(
        http.object("POST", "/v1/orgs/" + Http.encode(org) + "/tenants/" + Http.encode(tenantId) + "/token"));
  }

  public TenantToken token(Tenant tenant) {
    return token(tenant.id(), null);
  }

  public TenantToken token(Tenant tenant, String orgId) {
    return token(tenant.id(), orgId);
  }

  public Sai client(String tenantId) {
    return client(tenantId, null);
  }

  /**
   * A client that acts as the Tenant. It exchanges a token now, and again before a request when the
   * token has less than five minutes left. Uses this client's Organisation Key.
   */
  public Sai client(String tenantId, String orgId) {
    TenantToken first = token(tenantId, orgId);
    Object lock = new Object();
    TenantToken[] current = {first};
    return withCredential.apply(
        () -> {
          synchronized (lock) {
            if (current[0].expiresAt() - System.currentTimeMillis() < TOKEN_REFRESH_MARGIN_MS) {
              current[0] = token(tenantId, orgId);
            }
            return current[0].token();
          }
        });
  }

  public Sai client(Tenant tenant) {
    return client(tenant.id(), null);
  }

  public Sai client(Tenant tenant, String orgId) {
    return client(tenant.id(), orgId);
  }
}
