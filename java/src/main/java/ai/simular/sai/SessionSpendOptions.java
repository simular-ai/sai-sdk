package ai.simular.sai;

/** Paging and Organisation for {@code sai.usage().sessions()}. */
public final class SessionSpendOptions {
  Integer limit;
  String cursor;
  String orgId;

  public SessionSpendOptions limit(int limit) {
    this.limit = limit;
    return this;
  }

  /** The {@code nextCursor} of the page before. */
  public SessionSpendOptions cursor(String cursor) {
    this.cursor = cursor;
    return this;
  }

  /** The Organisation; default the client's. */
  public SessionSpendOptions orgId(String orgId) {
    this.orgId = orgId;
    return this;
  }
}
