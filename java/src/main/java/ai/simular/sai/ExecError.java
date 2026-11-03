package ai.simular.sai;

/**
 * Why a Simulang block failed.
 *
 * @param kind {@code exception}, {@code timeout} or {@code interrupted}
 */
public record ExecError(String kind, String message, String stack) {}
