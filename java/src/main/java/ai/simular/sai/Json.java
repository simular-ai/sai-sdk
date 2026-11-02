package ai.simular.sai;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** JSON in and out. Parsed JSON is plain Java: maps, lists, strings, numbers, booleans, null. */
final class Json {
  private static final ObjectMapper MAPPER =
      new ObjectMapper().enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

  private Json() {}

  /** Parses JSON text, read-only; throws {@link IllegalArgumentException} when it is not JSON. */
  static Object parse(String text) {
    try {
      return freeze(MAPPER.readValue(text, Object.class));
    } catch (JsonProcessingException e) {
      throw new IllegalArgumentException(e.getOriginalMessage(), e);
    }
  }

  private static Object freeze(Object v) {
    if (v instanceof Map<?, ?> m) {
      Map<String, Object> out = new LinkedHashMap<>();
      m.forEach((k, x) -> out.put((String) k, freeze(x)));
      return Collections.unmodifiableMap(out);
    }
    if (v instanceof List<?> l) {
      List<Object> out = new ArrayList<>(l.size());
      for (Object x : l) out.add(freeze(x));
      return Collections.unmodifiableList(out);
    }
    return v;
  }

  /** Compact JSON, as JavaScript's {@code JSON.stringify} writes it. */
  static String stringify(Object value) {
    StringBuilder sb = new StringBuilder();
    write(sb, value);
    return sb.toString();
  }

  private static void write(StringBuilder sb, Object v) {
    if (v == null) {
      sb.append("null");
    } else if (v instanceof String s) {
      quote(sb, s);
    } else if (v instanceof Boolean b) {
      sb.append(b);
    } else if (v instanceof Number n) {
      sb.append(number(n));
    } else if (v instanceof Map<?, ?> m) {
      sb.append('{');
      boolean first = true;
      for (Map.Entry<?, ?> e : m.entrySet()) {
        if (!first) sb.append(',');
        first = false;
        quote(sb, String.valueOf(e.getKey()));
        sb.append(':');
        write(sb, e.getValue());
      }
      sb.append('}');
    } else if (v instanceof Collection<?> c) {
      sb.append('[');
      boolean first = true;
      for (Object x : c) {
        if (!first) sb.append(',');
        first = false;
        write(sb, x);
      }
      sb.append(']');
    } else if (v instanceof Object[] a) {
      write(sb, List.of(a));
    } else if (v instanceof Enum<?> e) {
      quote(sb, e.toString());
    } else {
      quote(sb, v.toString());
    }
  }

  private static void quote(StringBuilder sb, String s) {
    sb.append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"' -> sb.append("\\\"");
        case '\\' -> sb.append("\\\\");
        case '\b' -> sb.append("\\b");
        case '\f' -> sb.append("\\f");
        case '\n' -> sb.append("\\n");
        case '\r' -> sb.append("\\r");
        case '\t' -> sb.append("\\t");
        default -> {
          boolean lone =
              Character.isHighSurrogate(c)
                  ? i + 1 >= s.length() || !Character.isLowSurrogate(s.charAt(i + 1))
                  : Character.isLowSurrogate(c)
                      && (i == 0 || !Character.isHighSurrogate(s.charAt(i - 1)));
          if (c < 0x20 || lone) {
            sb.append(String.format("\\u%04x", (int) c));
          } else {
            sb.append(c);
          }
        }
      }
    }
    sb.append('"');
  }

  /** A number as JavaScript prints it: no {@code .0} on integers, exponents from 1e21 up and below 1e-6. */
  static String number(Number n) {
    if (n instanceof Integer || n instanceof Long || n instanceof Short || n instanceof Byte
        || n instanceof java.math.BigInteger) {
      return n.toString();
    }
    double d = n.doubleValue();
    if (Double.isNaN(d) || Double.isInfinite(d)) return "null";
    if (d == 0) return "0";
    BigDecimal b = new BigDecimal(Double.toString(d)).stripTrailingZeros();
    double abs = Math.abs(d);
    if (abs >= 1e-6 && abs < 1e21) return b.toPlainString();
    String digits = b.unscaledValue().abs().toString();
    int exp = digits.length() - 1 - b.scale();
    String mantissa = digits.length() == 1 ? digits : digits.charAt(0) + "." + digits.substring(1);
    return (d < 0 ? "-" : "") + mantissa + "e" + (exp >= 0 ? "+" : "") + exp;
  }

  // ─── Reading parsed JSON, as the TypeScript SDK does ───────────────────────

  @SuppressWarnings("unchecked")
  static Map<String, Object> obj(Object v) {
    return v instanceof Map<?, ?> m ? (Map<String, Object>) m : Collections.emptyMap();
  }

  /** The object, or null when {@code v} is not one. */
  static Map<String, Object> objOrNull(Object v) {
    return v instanceof Map<?, ?> ? obj(v) : null;
  }

  static String str(Object v) {
    return v instanceof String s ? s : null;
  }

  static String str(Object v, String fallback) {
    return v instanceof String s ? s : fallback;
  }

  static double num(Object v) {
    return v instanceof Number n ? n.doubleValue() : 0;
  }

  static long lng(Object v) {
    return v instanceof Number n ? n.longValue() : 0;
  }

  static int integer(Object v) {
    return v instanceof Number n ? n.intValue() : 0;
  }

  static Long lngOrNull(Object v) {
    return v instanceof Number n ? n.longValue() : null;
  }

  static Double numOrNull(Object v) {
    return v instanceof Number n ? n.doubleValue() : null;
  }

  static Integer intOrNull(Object v) {
    return v instanceof Number n ? n.intValue() : null;
  }

  /** JavaScript's {@code Boolean(v)}. */
  static boolean truthy(Object v) {
    if (v == null) return false;
    if (v instanceof Boolean b) return b;
    if (v instanceof Number n) return n.doubleValue() != 0 && !Double.isNaN(n.doubleValue());
    if (v instanceof String s) return !s.isEmpty();
    return true;
  }

  static List<Object> list(Object v) {
    return v instanceof List<?> l ? Collections.unmodifiableList(l) : List.of();
  }

  static List<Map<String, Object>> objects(Object v) {
    List<Map<String, Object>> out = new ArrayList<>();
    for (Object x : list(v)) out.add(obj(x));
    return out;
  }

  static List<String> strings(Object v) {
    List<String> out = new ArrayList<>();
    for (Object x : list(v)) out.add(x == null ? null : x.toString());
    return Collections.unmodifiableList(out);
  }

  static Map<String, Object> copy(Map<String, Object> m) {
    return Collections.unmodifiableMap(new LinkedHashMap<>(m));
  }
}
