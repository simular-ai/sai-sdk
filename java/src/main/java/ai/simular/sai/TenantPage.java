package ai.simular.sai;

import java.util.List;

/**
 * One page of {@code tenants().list()}.
 *
 * @param nextCursor pass as {@code cursor} for the next page; null on the last page
 */
public record TenantPage(List<Tenant> tenants, String nextCursor) {}
