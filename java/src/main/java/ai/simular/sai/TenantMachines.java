package ai.simular.sai;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** A Tenant's computers, enrolled and cloud. Every call takes an Organisation Key. */
public final class TenantMachines {
  /** Between machine reads while {@code create} waits for a machine to be ready. */
  private static final long MACHINE_POLL_INTERVAL_MS = 5_000;

  private final Http http;

  TenantMachines(Http http) {
    this.http = http;
  }

  public TenantMachine create(String tenantId, String os) {
    return create(tenantId, os, null);
  }

  /**
   * Create a cloud machine for the Tenant. {@code os} is {@code windows} or {@code linux}; the size
   * follows it. Returns at once with state {@code provisioning}, or with {@code waitForReady} once
   * it is {@code ready}.
   */
  public TenantMachine create(String tenantId, String os, CreateMachineOptions opts) {
    CreateMachineOptions o = opts == null ? new CreateMachineOptions() : opts;
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("os", os);
    if (o.name != null) body.put("name", o.name);
    if (o.requestId != null) body.put("requestId", o.requestId);
    TenantMachine machine =
        TenantMachine.parse(http.object("POST", Tenants.path(tenantId) + "/machines", Http.Req.json(body)));
    if (!o.waitForReady) return machine;
    long deadline =
        System.currentTimeMillis() + (o.timeout != null ? o.timeout : Duration.ofMinutes(10)).toMillis();
    while (!"ready".equals(machine.state())) {
      if ("failed".equals(machine.state()) || "deleting".equals(machine.state())) {
        throw new SaiException(
            "Cloud machine " + machine.id() + " is " + machine.state() + " and will not become ready.",
            0, null, machine.raw(), null, null);
      }
      if (System.currentTimeMillis() + MACHINE_POLL_INTERVAL_MS > deadline) {
        throw new SaiTimeoutException("Cloud machine " + machine.id() + " still " + machine.state() + ".");
      }
      Sleep.millis(MACHINE_POLL_INTERVAL_MS);
      try {
        machine = get(tenantId, machine.id());
      } catch (RateLimitException e) {
        Sleep.retryAfter(e);
      }
    }
    return machine;
  }

  public TenantMachine create(Tenant tenant, String os) {
    return create(tenant.id(), os, null);
  }

  public TenantMachine create(Tenant tenant, String os, CreateMachineOptions opts) {
    return create(tenant.id(), os, opts);
  }

  /** Both kinds, enrolled and cloud. A cloud machine is listed from the moment it is created. */
  public List<TenantMachine> list(String tenantId) {
    List<TenantMachine> out = new ArrayList<>();
    for (Map<String, Object> m : Json.objects(http.object("GET", Tenants.path(tenantId) + "/machines").get("machines"))) {
      out.add(TenantMachine.parse(m));
    }
    return Collections.unmodifiableList(out);
  }

  public List<TenantMachine> list(Tenant tenant) {
    return list(tenant.id());
  }

  public TenantMachine get(String tenantId, String machineId) {
    return TenantMachine.parse(
        http.object("GET", Tenants.path(tenantId) + "/machines/" + Http.encode(machineId)));
  }

  public TenantMachine get(Tenant tenant, String machineId) {
    return get(tenant.id(), machineId);
  }

  /**
   * An enrolled machine is signed out at once ({@code revoked}); enroll it again with a new code to
   * bring it back. A cloud machine is deleted with its disk ({@code deleting}), which cannot be
   * undone.
   */
  public String delete(String tenantId, String machineId) {
    Http.Res res = http.request("DELETE", Tenants.path(tenantId) + "/machines/" + Http.encode(machineId), null);
    return res.status() == 202 ? "deleting" : "revoked";
  }

  public String delete(String tenantId, TenantMachine machine) {
    return delete(tenantId, machine.id());
  }

  public String delete(Tenant tenant, String machineId) {
    return delete(tenant.id(), machineId);
  }

  public String delete(Tenant tenant, TenantMachine machine) {
    return delete(tenant.id(), machine.id());
  }

  /** {@code delete} without its answer. On a cloud machine it deletes the machine: use {@code delete}. */
  public void revoke(String tenantId, String machineId) {
    delete(tenantId, machineId);
  }

  public void revoke(String tenantId, TenantMachine machine) {
    delete(tenantId, machine.id());
  }

  public void revoke(Tenant tenant, String machineId) {
    delete(tenant.id(), machineId);
  }

  public void revoke(Tenant tenant, TenantMachine machine) {
    delete(tenant.id(), machine.id());
  }
}
