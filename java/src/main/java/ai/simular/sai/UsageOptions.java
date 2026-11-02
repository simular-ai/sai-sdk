package ai.simular.sai;

/** Options for {@code sai.usage().get()}. Each defaults to a range that ends now. */
public final class UsageOptions {
  String granularity;
  String from;
  String to;
  String orgId;

  /** {@code hour}, {@code day} (the default) or {@code month}. */
  public UsageOptions granularity(String granularity) {
    this.granularity = granularity;
    return this;
  }

  /** {@code 2026-10} for a month, {@code 2026-10-15} for a day, {@code 2026-10-15T09} for an hour. */
  public UsageOptions from(String from) {
    this.from = from;
    return this;
  }

  public UsageOptions to(String to) {
    this.to = to;
    return this;
  }

  /** The Organisation; default the client's. */
  public UsageOptions orgId(String orgId) {
    this.orgId = orgId;
    return this;
  }
}
