package ai.simular.sai;

/**
 * A wait ran past its {@code timeout} with the work still going (a turn, a learn job, a cloud
 * machine). The work keeps going on the server. Not an API error: not a {@link SaiException}.
 */
public class SaiTimeoutException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  public SaiTimeoutException(String message) {
    super(message);
  }
}
