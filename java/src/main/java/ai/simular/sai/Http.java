package ai.simular.sai;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Supplier;

/** The one place requests are made: auth header, error mapping, timeouts. */
final class Http {
  /** One request's options. */
  static final class Req {
    Object json;
    Map<String, Object> params;
    byte[] body;
    Map<String, String> headers;
    Duration timeout;

    static Req json(Object json) {
      Req r = new Req();
      r.json = json;
      return r;
    }

    static Req params(Map<String, Object> params) {
      Req r = new Req();
      r.params = params;
      return r;
    }

    Req timeout(Duration timeout) {
      this.timeout = timeout;
      return this;
    }
  }

  /** A response: status and body. */
  record Res(int status, byte[] body) {}

  private final Supplier<String> credential;
  private final String baseUrl;
  private final Duration timeout;
  private final String versionTag;
  private final HttpClient client;

  Http(Supplier<String> credential, String baseUrl, Duration timeout, String versionTag, HttpClient client) {
    this.credential = credential;
    this.baseUrl = baseUrl.replaceAll("/+$", "");
    this.timeout = timeout;
    this.versionTag = versionTag;
    this.client = client;
  }

  Res request(String method, String path, Req opts) {
    Req o = opts == null ? new Req() : opts;
    StringBuilder url = new StringBuilder(baseUrl).append(path);
    if (o.params != null) {
      String sep = "?";
      for (Map.Entry<String, Object> e : o.params.entrySet()) {
        if (e.getValue() == null) continue;
        Object v = e.getValue();
        url.append(sep).append(encode(e.getKey())).append('=')
            .append(encode(v instanceof Number n ? Json.number(n) : v.toString()));
        sep = "&";
      }
    }
    URI uri = URI.create(url.toString());
    HttpRequest.Builder b =
        HttpRequest.newBuilder(uri)
            .timeout(o.timeout != null ? o.timeout : timeout)
            .header("User-Agent", "sai-java/" + Sai.VERSION)
            .header("Authorization", "Bearer " + credential.get());
    // plain http (a local server) has no HTTP/2 to upgrade to
    if ("http".equals(uri.getScheme())) b.version(HttpClient.Version.HTTP_1_1);
    // routes the request to a tagged API revision
    if (versionTag != null && !versionTag.isEmpty()) b.header("x-sai-version", versionTag);
    byte[] body = o.body;
    if (o.json != null) {
      b.header("Content-Type", "application/json");
      body = Json.stringify(o.json).getBytes(StandardCharsets.UTF_8);
    }
    if (o.headers != null) o.headers.forEach(b::header);
    b.method(
        method,
        body == null
            ? HttpRequest.BodyPublishers.noBody()
            : HttpRequest.BodyPublishers.ofByteArray(body));
    HttpResponse<byte[]> res;
    try {
      res = client.send(b.build(), HttpResponse.BodyHandlers.ofByteArray());
    } catch (HttpTimeoutException e) {
      throw new SaiConnectionException("Request to " + host(uri) + " timed out.", e);
    } catch (IOException e) {
      String detail = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
      throw new SaiConnectionException(
          "Could not reach the Sai API at " + host(uri) + ": " + detail
              + ". Check the network and SAI_API_URL.",
          e);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new SaiConnectionException("Request to " + host(uri) + " was interrupted.", e);
    }
    if (res.statusCode() >= 400) throw toError(res);
    return new Res(res.statusCode(), res.body() == null ? new byte[0] : res.body());
  }

  /** The parsed JSON body, or null when it is empty. */
  Object json(String method, String path, Req opts) {
    Res res = request(method, path, opts);
    String text = new String(res.body(), StandardCharsets.UTF_8);
    return text.isEmpty() ? null : Json.parse(text);
  }

  Map<String, Object> object(String method, String path, Req opts) {
    return Json.obj(json(method, path, opts));
  }

  Map<String, Object> object(String method, String path) {
    return object(method, path, null);
  }

  private static SaiException toError(HttpResponse<byte[]> res) {
    String text = res.body() == null ? "" : new String(res.body(), StandardCharsets.UTF_8);
    Map<String, Object> body;
    try {
      Object parsed = Json.parse(text);
      if (parsed instanceof Map<?, ?>) {
        body = Json.obj(parsed);
      } else {
        body = new LinkedHashMap<>();
        body.put("error", jsString(parsed));
      }
    } catch (IllegalArgumentException e) {
      body = new LinkedHashMap<>();
      String head = text.length() > 500 ? text.substring(0, 500) : text;
      body.put("error", head.isEmpty() ? "HTTP " + res.statusCode() : head);
    }
    Double retryAfter = null;
    String raw = res.headers().firstValue("retry-after").orElse(null);
    if (raw != null && !raw.isBlank()) {
      try {
        retryAfter = Double.parseDouble(raw.trim());
      } catch (NumberFormatException ignored) {
        // an HTTP date: not a number of seconds
      }
    }
    return SaiException.forResponse(res.statusCode(), body, retryAfter);
  }

  /** JavaScript's {@code String(v)} for parsed JSON. */
  private static String jsString(Object v) {
    if (v == null) return "null";
    if (v instanceof Number n) return Json.number(n);
    if (v instanceof java.util.List<?> l) {
      StringBuilder sb = new StringBuilder();
      for (int i = 0; i < l.size(); i++) {
        if (i > 0) sb.append(',');
        Object x = l.get(i);
        sb.append(x == null ? "" : jsString(x));
      }
      return sb.toString();
    }
    return v.toString();
  }

  private static String host(URI uri) {
    return uri.getPort() == -1 ? uri.getHost() : uri.getHost() + ":" + uri.getPort();
  }

  private static final String UNRESERVED =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()";

  /** JavaScript's {@code encodeURIComponent}: a space is {@code %20}, never {@code +}. */
  static String encode(String s) {
    StringBuilder sb = new StringBuilder();
    for (byte b : s.getBytes(StandardCharsets.UTF_8)) {
      int c = b & 0xff;
      if (c < 0x80 && UNRESERVED.indexOf(c) >= 0) {
        sb.append((char) c);
      } else {
        sb.append('%').append(Character.toUpperCase(Character.forDigit(c >> 4, 16)))
            .append(Character.toUpperCase(Character.forDigit(c & 0xf, 16)));
      }
    }
    return sb.toString();
  }
}
