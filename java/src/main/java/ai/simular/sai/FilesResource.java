package ai.simular.sai;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/** Files to attach to a message. */
public final class FilesResource {
  private final Http http;

  FilesResource(Http http) {
    this.http = http;
  }

  /** Upload a file from disk (max 25 MB), under its own name. */
  public Attachment upload(Path file) {
    return upload(file, file.getFileName().toString());
  }

  public Attachment upload(Path file, String name) {
    byte[] data;
    try {
      data = java.nio.file.Files.readAllBytes(file);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
    return upload(data, name);
  }

  /** Upload bytes (max 25 MB) as a file named {@code name}, to attach to a message. */
  public Attachment upload(byte[] data, String name) {
    Http.Req req = new Http.Req();
    req.body = data;
    Map<String, String> headers = new LinkedHashMap<>();
    // The server reads only a body that has a Content-Type; it derives the MIME type from the name.
    headers.put("Content-Type", "application/octet-stream");
    headers.put("x-filename", Http.encode(name));
    req.headers = headers;
    req.timeout = Duration.ofSeconds(120);
    return Attachment.parse(http.object("POST", "/v1/agents/upload", req));
  }
}
