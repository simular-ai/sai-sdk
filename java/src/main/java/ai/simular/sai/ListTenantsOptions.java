package ai.simular.sai;

/** Filters and paging for {@code sai.tenants().list()}. */
public final class ListTenantsOptions {
  String status;
  String externalId;
  Integer limit;
  String cursor;

  /** {@code active} or {@code disabled}. */
  public ListTenantsOptions status(String status) {
    this.status = status;
    return this;
  }

  /** Finds the Tenant with this id of yours (zero or one); cannot be combined with {@code status}. */
  public ListTenantsOptions externalId(String externalId) {
    this.externalId = externalId;
    return this;
  }

  public ListTenantsOptions limit(int limit) {
    this.limit = limit;
    return this;
  }

  /** The {@code nextCursor} of the page before. */
  public ListTenantsOptions cursor(String cursor) {
    this.cursor = cursor;
    return this;
  }
}
