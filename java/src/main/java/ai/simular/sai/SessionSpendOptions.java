package ai.simular.sai;

import java.util.List;

/** Paging, real-time lookup and Organisation for {@code sai.usage().sessions()}. */
public final class SessionSpendOptions {
  Integer limit;
  String cursor;
  List<String> sessionIds;
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

  /**
   * Look these sessions (1 to 50 of the Tenant's) up in real time instead of a date range: each
   * comes back with its spend so far and {@code settled}, and the page with {@code asOf}; no
   * paging. Use with {@code sessions(tenant, opts)}, without {@code from}, {@code to}, {@code
   * limit} or {@code cursor}.
   */
  public SessionSpendOptions sessionIds(List<String> sessionIds) {
    this.sessionIds = sessionIds;
    return this;
  }

  public SessionSpendOptions sessionIds(String... sessionIds) {
    return sessionIds(sessionIds == null ? null : List.of(sessionIds));
  }

  /** The Organisation; default the client's. */
  public SessionSpendOptions orgId(String orgId) {
    this.orgId = orgId;
    return this;
  }
}
