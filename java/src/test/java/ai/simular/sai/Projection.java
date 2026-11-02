package ai.simular.sai;

import java.lang.reflect.RecordComponent;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** What a call returned, as JSON for the mock server (conformance/README.md#projection). */
final class Projection {
  private Projection() {}

  /** A call that returns free-form JSON: projected as is. */
  record Opaque(Object value) {}

  /** Record components whose snake_case name is not the surface's. */
  private static final Map<String, String> RENAMED = Map.of("isFinal", "final");

  /** The surface's error names for this SDK's exceptions (AGENTS.md: idiom allowed). */
  static String surfaceName(Class<?> cls) {
    String name = cls.getSimpleName();
    if (name.equals("SaiException")) return "SaiError";
    if (name.equals("SaiConnectionException")) return "ConnectionError";
    if (name.endsWith("Exception")) return name.substring(0, name.length() - "Exception".length()) + "Error";
    return name;
  }

  static String snake(String s) {
    String n = RENAMED.getOrDefault(s, s);
    StringBuilder sb = new StringBuilder();
    for (char c : n.toCharArray()) {
      if (Character.isUpperCase(c)) sb.append('_').append(Character.toLowerCase(c));
      else sb.append(c);
    }
    return sb.toString();
  }

  static Object project(Object v) {
    if (v == null) return null;
    if (v instanceof Opaque o) return o.value();
    if (v instanceof byte[] b) return Map.of("$base64", Base64.getEncoder().encodeToString(b));
    if (v instanceof Sai) return Map.of();
    if (v instanceof Session s) {
      Map<String, Object> m = new LinkedHashMap<>();
      m.put("id", s.id());
      m.put("machine_id", s.machineId());
      return m;
    }
    if (v instanceof Turn t) {
      Map<String, Object> m = new LinkedHashMap<>();
      m.put("id", t.id());
      m.put("queued", t.queued());
      m.put("status", t.status().value());
      return m;
    }
    if (v instanceof ControlLease l) {
      Map<String, Object> m = new LinkedHashMap<>();
      m.put("machine_id", l.machineId());
      m.put("idle_timeout_sec", l.idleTimeoutSec());
      return m;
    }
    if (v instanceof Enum<?> e) return e.toString();
    if (v instanceof List<?> l) {
      List<Object> out = new ArrayList<>();
      for (Object x : l) out.add(project(x));
      return out;
    }
    // Maps are keyed by ids, names or free-form JSON keys: the keys stay.
    if (v instanceof Map<?, ?> m) {
      Map<String, Object> out = new LinkedHashMap<>();
      m.forEach((k, x) -> out.put(String.valueOf(k), project(x)));
      return out;
    }
    if (v instanceof Record r) {
      Map<String, Object> out = new LinkedHashMap<>();
      for (RecordComponent c : r.getClass().getRecordComponents()) {
        if (c.getName().equals("raw")) continue;
        out.put(snake(c.getName()), project(read(r, c)));
      }
      return out;
    }
    return v;
  }

  private static Object read(Record r, RecordComponent c) {
    try {
      return c.getAccessor().invoke(r);
    } catch (ReflectiveOperationException e) {
      throw new IllegalStateException(e);
    }
  }

  /** A saved step's part: a dotted path of snake_case field names and list indexes. */
  static Object pick(Object value, String path) {
    Object v = value;
    for (String part : path.split("\\.")) {
      if (v instanceof List<?> l) {
        v = l.get(Integer.parseInt(part));
      } else if (v instanceof Record r) {
        Object next = null;
        for (RecordComponent c : r.getClass().getRecordComponents()) {
          if (snake(c.getName()).equals(part)) next = read(r, c);
        }
        v = next;
      } else if (v instanceof Map<?, ?> m) {
        v = m.get(part);
      } else {
        throw new IllegalStateException("cannot pick " + part + " from " + v);
      }
    }
    return v;
  }

  static Map<String, Object> projectError(Throwable err) {
    Map<String, Object> out = new LinkedHashMap<>();
    if (!(err instanceof SaiException e)) {
      out.put("class", err.getClass().getSimpleName());
      out.put("message", String.valueOf(err.getMessage()));
      return out;
    }
    out.put("class", surfaceName(e.getClass()));
    out.put("status", e.status());
    out.put("code", e.code());
    out.put("message", e.getMessage());
    out.put("retry_after", e.retryAfter());
    out.put("body", e.body());
    if (e instanceof LinkOnlyApprovalException l) out.put("approval_url", l.approvalUrl());
    if (e instanceof SpendCapReachedException s) out.put("resets_at", s.resetsAt());
    if (e instanceof BlockException b) out.put("kind", b.kind());
    return out;
  }
}
