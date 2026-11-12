package ai.simular.sai;

import java.util.LinkedHashMap;
import java.util.Map;

/** The changes for {@code sai.tenants().update()}; what is not set stays as it is. */
public final class UpdateTenantOptions {
  final Map<String, Object> body = new LinkedHashMap<>();

  public UpdateTenantOptions name(String name) {
    body.put("name", name);
    return this;
  }

  /** Replaces the whole map. */
  public UpdateTenantOptions metadata(Map<String, String> metadata) {
    body.put("metadata", metadata);
    return this;
  }

  /** {@code disabled} stops the Tenant's tokens and machines; {@code active} brings it back. */
  public UpdateTenantOptions status(String status) {
    body.put("status", status);
    return this;
  }

  /**
   * Caps the Tenant's cloud machines (0 to 1000); null removes the cap. Lowering it deletes
   * nothing: creates are refused until the count fits. Only the Organisation Key or an owner may
   * set it.
   */
  public UpdateTenantOptions cloudMachineLimit(Integer cloudMachineLimit) {
    body.put("cloudMachineLimit", cloudMachineLimit);
    return this;
  }

  /** The residential proxy switch; it has no effect yet, and traffic goes direct. */
  public UpdateTenantOptions residentialProxy(boolean residentialProxy) {
    body.put("residentialProxy", residentialProxy);
    return this;
  }

  /**
   * Lets the Tenant's learn jobs and direct control run code on its enrolled machines (default
   * off). Only the Organisation Key or an owner may set it.
   */
  public UpdateTenantOptions ownComputerAccess(boolean ownComputerAccess) {
    body.put("ownComputerAccess", ownComputerAccess);
    return this;
  }
}
