package ai.simular.sai;

import java.util.Map;

/** Options for {@code sai.tenants().create()}. */
public final class CreateTenantOptions {
  String externalId;
  Map<String, String> metadata;

  /** Your id for the customer, unique in the Organisation. It cannot change later. */
  public CreateTenantOptions externalId(String externalId) {
    this.externalId = externalId;
    return this;
  }

  public CreateTenantOptions metadata(Map<String, String> metadata) {
    this.metadata = metadata;
    return this;
  }
}
