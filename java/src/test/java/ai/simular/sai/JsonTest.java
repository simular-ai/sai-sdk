package ai.simular.sai;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Simulang helpers send code with JSON in it: it must be byte for byte what JSON.stringify writes. */
class JsonTest {
  @Test
  void stringifiesLikeJavaScript() {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("path", "C:\\a \"b\".txt");
    m.put("text", "héllo 世界 😀\n\t\u0001\u2028/");
    m.put("n", 3);
    m.put("d", 3.0);
    m.put("f", 0.1);
    m.put("big", 1e21);
    m.put("small", 1e-7);
    m.put("tiny", 0.000001);
    m.put("neg", -2.5e-8);
    m.put("list", Arrays.asList(true, null, List.of()));
    m.put("lone", "\ud800x");
    assertEquals(
        "{\"path\":\"C:\\\\a \\\"b\\\".txt\",\"text\":\"héllo 世界 😀\\n\\t\\u0001\u2028/\",\"n\":3,"
            + "\"d\":3,\"f\":0.1,\"big\":1e+21,\"small\":1e-7,\"tiny\":0.000001,\"neg\":-2.5e-8,"
            + "\"list\":[true,null,[]],\"lone\":\"\\ud800x\"}",
        Json.stringify(m));
  }

  @Test
  void encodesLikeEncodeUriComponent() {
    assertEquals("a%20b%2Fc!~*'()%C3%A9", Http.encode("a b/c!~*'()é"));
  }
}
