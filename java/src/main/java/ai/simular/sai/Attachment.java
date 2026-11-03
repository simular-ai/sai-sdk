package ai.simular.sai;

import java.util.Map;

/** A file uploaded with {@code sai.files().upload()}. Pass it in {@code attachments}. */
public record Attachment(String fileId, String name, String mime, long size, Map<String, Object> raw) {
  static Attachment parse(Map<String, Object> d) {
    return new Attachment(
        Json.str(d.get("fileId"), ""),
        Json.str(d.get("name"), ""),
        Json.str(d.get("mime"), ""),
        Json.lng(d.get("size")),
        d);
  }
}
