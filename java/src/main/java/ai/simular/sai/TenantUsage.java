package ai.simular.sai;

import java.util.Map;

/**
 * One Tenant's spend in an Organisation usage report.
 *
 * @param byCategory by kind of spend, such as {@code token} for AI calls and {@code compute} for
 *     computer time
 */
public record TenantUsage(
    String tenantId, String name, String externalId, long costCents, Map<String, CategoryUsage> byCategory) {}
