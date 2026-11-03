package ai.simular.sai;

import java.util.Base64;
import java.util.List;
import java.util.Map;

/**
 * What one Simulang block returned. A block that threw is still a result: check {@code error}.
 *
 * @param result what the block's last expression evaluated to, as JSON
 * @param screenshot the screenshot the block captured (page/app snapshot, pageContent), decoded
 * @param screenshotMimeType {@code image/jpeg} or {@code image/png}
 */
public record ExecResult(
    Object result,
    List<String> logs,
    ExecError error,
    byte[] screenshot,
    String screenshotMimeType,
    boolean screenshotOmitted,
    List<Map<String, Object>> variables,
    long durationMs,
    boolean ok,
    Map<String, Object> raw) {

  static ExecResult parse(Map<String, Object> d) {
    Map<String, Object> obs = Json.obj(d.get("observations"));
    Map<String, Object> shot = Json.obj(obs.get("screenshot"));
    Map<String, Object> err = Json.truthy(d.get("error")) ? Json.obj(d.get("error")) : null;
    String b64 = Json.str(shot.get("base64"));
    byte[] screenshot = b64 != null && !b64.isEmpty() ? Base64.getMimeDecoder().decode(b64) : null;
    ExecError error =
        err == null
            ? null
            : new ExecError(
                Json.str(err.get("kind"), ""), Json.str(err.get("message"), ""), Json.str(err.get("stack")));
    return new ExecResult(
        d.get("result"),
        Json.strings(d.get("logs")),
        error,
        screenshot,
        Json.str(shot.get("mimeType")),
        Json.truthy(obs.get("screenshotOmitted")),
        Json.objects(d.get("variables")),
        Json.lng(d.get("durationMs")),
        error == null,
        d);
  }
}
