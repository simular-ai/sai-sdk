package ai.simular.sai;

import java.util.Map;

/** What {@code lease.shell()} ran: the command's output and exit code. */
public record ShellResult(String stdout, String stderr, int exitCode, boolean timedOut) {
  static ShellResult parse(Object result) {
    Map<String, Object> r = Json.obj(result);
    return new ShellResult(
        Json.str(r.get("stdout"), ""),
        Json.str(r.get("stderr"), ""),
        Json.integer(r.get("exitCode")),
        Json.truthy(r.get("timedOut")));
  }
}
