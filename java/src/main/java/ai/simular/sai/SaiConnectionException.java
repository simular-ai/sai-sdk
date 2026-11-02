package ai.simular.sai;

/** The API could not be reached (DNS, TLS, timeout). */
public class SaiConnectionException extends SaiException {
  private static final long serialVersionUID = 1L;

  public SaiConnectionException(String message, Throwable cause) {
    super(message, 0, null, null, null, cause);
  }
}
