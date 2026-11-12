package ai.simular.sai;

import java.util.Map;

/**
 * One of your customers under an Organisation.
 *
 * @param externalId your id for the customer; unique in the Organisation, set on create only
 * @param status {@code active} or {@code disabled}
 * @param createdAt Unix time in milliseconds
 * @param machineCount enrolled machines
 * @param cloudMachineLimit most cloud machines the Tenant may have at once; null: no limit
 * @param residentialProxy the residential proxy switch (no effect yet); null from {@code list}
 * @param cloudMachineCount set by {@code get} and {@code update}; null from {@code list}
 * @param ownComputerAccess whether learn jobs and direct control may run code on the Tenant's
 *     enrolled machines; null from {@code list} and from older servers
 */
public record Tenant(
    String id,
    String name,
    String externalId,
    Map<String, Object> metadata,
    String status,
    long createdAt,
    Long disabledAt,
    long machineCount,
    Long cloudMachineLimit,
    Boolean residentialProxy,
    Long cloudMachineCount,
    Boolean ownComputerAccess,
    Map<String, Object> raw) {

  static Tenant parse(Map<String, Object> d) {
    return new Tenant(
        Json.str(d.get("tenantId"), ""),
        Json.str(d.get("name"), ""),
        Json.str(d.get("externalId")),
        Json.obj(d.get("metadata")),
        Json.str(d.get("status"), ""),
        Json.lng(d.get("createdAt")),
        Json.lngOrNull(d.get("disabledAt")),
        Json.lng(d.get("machineCount")),
        Json.lngOrNull(d.get("cloudMachineLimit")),
        d.get("residentialProxy") instanceof Boolean b ? b : null,
        Json.lngOrNull(d.get("cloudMachineCount")),
        d.get("ownComputerAccess") instanceof Boolean o ? o : null,
        d);
  }
}
