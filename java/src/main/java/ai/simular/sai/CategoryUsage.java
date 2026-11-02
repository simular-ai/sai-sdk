package ai.simular.sai;

/** One kind of spend in a usage report, such as {@code token} or {@code compute}. */
public record CategoryUsage(long costCents) {}
