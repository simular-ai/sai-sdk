package ai.simular.sai;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A lease on a computer, from {@code sai.control().open()}. Close it when done:
 * try-with-resources does.
 */
public final class ControlLease implements AutoCloseable {
  private static final Duration EXEC_TIMEOUT = Duration.ofSeconds(120);
  private static final Duration EXEC_SLACK = Duration.ofSeconds(45);

  private final Http http;
  private final String machineId;
  private final long idleTimeoutSec;
  private final String path;
  private volatile boolean closed;

  ControlLease(Http http, String machineId, long idleTimeoutSec) {
    this.http = http;
    this.machineId = machineId;
    this.idleTimeoutSec = idleTimeoutSec;
    this.path = path(machineId);
  }

  static String path(String machineId) {
    return "/v1/machines/" + Http.encode(machineId) + "/control";
  }

  public String machineId() {
    return machineId;
  }

  /** Seconds the lease may sit idle before it closes. */
  public long idleTimeoutSec() {
    return idleTimeoutSec;
  }

  public ExecResult exec(String code) {
    return exec(code, null);
  }

  /**
   * Run one Simulang (JavaScript) block. Use {@code var} for anything the next block needs. A block
   * that throws, times out or is interrupted still returns: check {@code result.error()}. Throws
   * {@link GoneException} once the lease has ended (closed, idle, taken by a Sai task, or the
   * computer stopped answering): open again. {@code timeout} (null: the server's default) limits the
   * block.
   */
  public ExecResult exec(String code, Duration timeout) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("code", code);
    if (timeout != null) body.put("timeoutMs", timeout.toMillis());
    Duration wait = (timeout != null ? timeout : EXEC_TIMEOUT).plus(EXEC_SLACK);
    return ExecResult.parse(http.object("POST", path + "/exec", Http.Req.json(body).timeout(wait)));
  }

  public ExecResult run(LearnResult learned) {
    return run(learned, Map.of(), null);
  }

  public ExecResult run(LearnResult learned, Map<String, ?> inputs) {
    return run(learned, inputs, null);
  }

  /**
   * Run code from {@code sai.learn().create()}: its {@code main} with {@code inputs} over the
   * parameters' defaults (missing inputs keep their defaults). {@code main}'s return value is
   * {@code result.result()}.
   */
  public ExecResult run(LearnResult learned, Map<String, ?> inputs, Duration timeout) {
    Map<String, Object> args = new LinkedHashMap<>();
    for (LearnParameter p : learned.parameters()) args.put(p.name(), p.defaultValue());
    if (inputs != null) args.putAll(inputs);
    return exec(learned.code() + "\nawait main(" + Json.stringify(args) + ")", timeout);
  }

  public ExecResult run(String code) {
    return run(code, Map.of(), null);
  }

  public ExecResult run(String code, Map<String, ?> inputs) {
    return run(code, inputs, null);
  }

  /** Run code that defines {@code main}, with {@code inputs} as is. */
  public ExecResult run(String code, Map<String, ?> inputs, Duration timeout) {
    return exec(code + "\nawait main(" + Json.stringify(inputs == null ? Map.of() : inputs) + ")", timeout);
  }

  public ShellResult shell(String command) {
    return shell(command, null, null);
  }

  public ShellResult shell(String command, String cwd) {
    return shell(command, cwd, null);
  }

  /**
   * Run a shell command on the computer. {@code cwd} and {@code timeout} may be null. Throws {@link
   * BlockException} when the block fails.
   */
  public ShellResult shell(String command, String cwd, Duration timeout) {
    Map<String, Object> args = new LinkedHashMap<>();
    args.put("command", command);
    if (cwd != null && !cwd.isEmpty()) args.put("cwd", cwd);
    ExecResult r = exec("await machine.exec(" + Json.stringify(args) + ")", timeout);
    raiseOnBlockError(r);
    return ShellResult.parse(r.result());
  }

  public String readFile(String path) {
    ExecResult r = exec("await machine.readFile(" + Json.stringify(Map.of("path", path)) + ")");
    raiseOnBlockError(r);
    return r.result() instanceof String s ? s : r.result() == null ? null : r.result().toString();
  }

  public void writeFile(String path, String text) {
    Map<String, Object> args = new LinkedHashMap<>();
    args.put("path", path);
    args.put("text", text);
    args.put("overwrite", true);
    raiseOnBlockError(exec("await machine.writeToFile(" + Json.stringify(args) + ")"));
  }

  /**
   * The whole screen as image bytes (usually JPEG; use {@code exec} for the MIME type). Needs the
   * computer's screen-capture service; throws {@link BlockException} where it is off.
   */
  public byte[] screenshot() {
    ExecResult r = exec("var __sai_page = await machine.pageContent(); null");
    raiseOnBlockError(r);
    if (r.screenshot() == null) {
      throw new BlockException(
          "exception", r.screenshotOmitted() ? "screenshot too large to return" : "no screenshot");
    }
    return r.screenshot();
  }

  /** Stop the running block at its next step. False if nothing was running. */
  public boolean interrupt() {
    return Json.truthy(Json.obj(http.json("POST", path + "/interrupt", null)).get("interrupted"));
  }

  /** The lease's state: {@code { status: open|closed, closedReason?, lastExecAt, ... }}. */
  public Map<String, Object> get() {
    return http.object("GET", path);
  }

  /** Clear the REPL and release the computer. Safe to call twice. */
  @Override
  public void close() {
    if (closed) return;
    try {
      http.request("DELETE", path, null);
    } catch (GoneException e) {
      // already ended
    }
    closed = true;
  }

  private static void raiseOnBlockError(ExecResult r) {
    if (r.error() != null) throw new BlockException(r.error().kind(), r.error().message());
  }
}
