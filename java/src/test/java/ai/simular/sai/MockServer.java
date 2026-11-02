package ai.simular.sai;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Map;

/** The shared mock Sai API, {@code node ../conformance/server.mjs}. It exits with this JVM. */
final class MockServer implements AutoCloseable {
  static final Path CONFORMANCE = Path.of("..", "conformance").toAbsolutePath().normalize();
  static final ObjectMapper MAPPER = new ObjectMapper();

  final String url;
  private final Process process;
  private final HttpClient client =
      HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();

  MockServer() throws IOException {
    // stdin stays an open pipe: the server exits when it closes.
    process =
        new ProcessBuilder("node", CONFORMANCE.resolve("server.mjs").toString())
            .redirectError(ProcessBuilder.Redirect.INHERIT)
            .start();
    BufferedReader out =
        new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
    String line = out.readLine();
    if (line == null || !line.startsWith("SAI_MOCK_URL=")) {
      throw new IOException("mock server did not start: " + line);
    }
    url = line.substring("SAI_MOCK_URL=".length()).trim();
  }

  /** POST /__mock/{what} with a JSON body; the JSON answer. */
  @SuppressWarnings("unchecked")
  Map<String, Object> control(String what, Object body) throws IOException, InterruptedException {
    HttpRequest req =
        HttpRequest.newBuilder(URI.create(url + "/__mock/" + what))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(body)))
            .build();
    String text = client.send(req, HttpResponse.BodyHandlers.ofString()).body();
    return MAPPER.readValue(text, Map.class);
  }

  @Override
  public void close() {
    process.destroy();
  }
}
