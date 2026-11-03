package ai.simular.sai;

/**
 * A control helper's Simulang block failed on the computer. {@link #kind()} is {@code exception},
 * {@code timeout} or {@code interrupted}.
 */
public class BlockException extends SaiException {
  private static final long serialVersionUID = 1L;

  private final String kind;

  public BlockException(String kind, String message) {
    super(kind + ": " + message, 0, kind, null, null, null);
    this.kind = kind;
  }

  public String kind() {
    return kind;
  }
}
