package ai.simular.sai;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Stream;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Parity with surface.json, the contract every language's SDK implements (AGENTS.md). Names map
 * snake_case to camelCase, with these Java idioms:
 *
 * <ul>
 *   <li>{@code wait} is {@code waitFor}: {@code Object.wait()} is final.
 *   <li>Errors end in {@code Exception}: {@code NotFoundError} is {@code NotFoundException}, {@code
 *       SaiError} is {@code SaiException}, and {@code ConnectionError} is {@code
 *       SaiConnectionException} (no clash with {@code java.net.ConnectException}).
 *   <li>Enums are Java enums whose {@code value()} is the surface's string.
 *   <li>Properties are accessor methods, so the object tests leave them out.
 * </ul>
 */
class SurfaceTest {
  private static final Map<String, String> JAVA_NAMES = Map.of("wait", "waitFor");
  /** Accessor methods, which are properties in the other SDKs. */
  private static final Map<Class<?>, Set<String>> PROPERTIES =
      Map.of(
          Session.class, Set.of("id", "machineId"),
          Turn.class, Set.of("id", "queued", "status", "result", "session"),
          ControlLease.class, Set.of("machineId", "idleTimeoutSec"));

  @SuppressWarnings("unchecked")
  private static final Map<String, Object> SURFACE = read();

  @SuppressWarnings("unchecked")
  private static Map<String, Object> read() {
    try {
      return MockServer.MAPPER.readValue(Path.of("..", "surface.json").toFile(), Map.class);
    } catch (IOException e) {
      throw new IllegalStateException(e);
    }
  }

  static String camel(String s) {
    StringBuilder sb = new StringBuilder();
    boolean up = false;
    for (char c : s.toCharArray()) {
      if (c == '_') {
        up = true;
      } else {
        sb.append(up ? Character.toUpperCase(c) : c);
        up = false;
      }
    }
    String name = sb.toString();
    return JAVA_NAMES.getOrDefault(name, name);
  }

  private static Set<String> expected(List<String> names) {
    Set<String> out = new TreeSet<>();
    for (String n : names) out.add(camel(n));
    return out;
  }

  private static Set<String> publicMethods(Class<?> cls) {
    Set<String> out = new TreeSet<>();
    for (Method m : cls.getDeclaredMethods()) {
      int mod = m.getModifiers();
      if (Modifier.isPublic(mod) && !Modifier.isStatic(mod) && !m.isSynthetic()) out.add(m.getName());
    }
    out.removeAll(PROPERTIES.getOrDefault(cls, Set.of()));
    out.removeAll(Set.of("toString", "equals", "hashCode"));
    return out;
  }

  @SuppressWarnings("unchecked")
  private static Map<String, List<String>> resources() {
    return (Map<String, List<String>>) SURFACE.get("resources");
  }

  @Test
  void clientResources() {
    assertEquals(expected(resources().get("client")), publicMethods(Sai.class));
  }

  @TestFactory
  Stream<DynamicTest> resourceMethods() throws NoSuchMethodException {
    List<DynamicTest> tests = new ArrayList<>();
    for (Map.Entry<String, List<String>> e : resources().entrySet()) {
      if (e.getKey().equals("client")) continue;
      Class<?> cls = Sai.class.getMethod(camel(e.getKey())).getReturnType();
      tests.add(
          DynamicTest.dynamicTest(
              e.getKey(), () -> assertEquals(expected(e.getValue()), publicMethods(cls))));
    }
    return tests.stream();
  }

  @TestFactory
  @SuppressWarnings("unchecked")
  Stream<DynamicTest> objectMethods() {
    Map<String, List<String>> objects = (Map<String, List<String>>) SURFACE.get("objects");
    Map<String, Class<?>> classes =
        Map.of("Session", Session.class, "Turn", Turn.class, "ControlLease", ControlLease.class);
    assertEquals(new TreeSet<>(objects.keySet()), new TreeSet<>(classes.keySet()));
    return objects.entrySet().stream()
        .map(
            e ->
                DynamicTest.dynamicTest(
                    e.getKey(),
                    () -> assertEquals(expected(e.getValue()), publicMethods(classes.get(e.getKey())))));
  }

  @Test
  @SuppressWarnings("unchecked")
  void errors() throws IOException, ClassNotFoundException {
    Path dir = Path.of("target", "classes", "ai", "simular", "sai");
    Set<String> exported = new TreeSet<>();
    try (Stream<Path> files = Files.list(dir)) {
      for (Path f : files.toList()) {
        String file = f.getFileName().toString();
        if (!file.endsWith(".class") || file.contains("$")) continue;
        Class<?> cls = Class.forName("ai.simular.sai." + file.replace(".class", ""));
        if (Modifier.isPublic(cls.getModifiers()) && SaiException.class.isAssignableFrom(cls)) {
          exported.add(Projection.surfaceName(cls));
        }
      }
    }
    assertEquals(new TreeSet<>((List<String>) SURFACE.get("errors")), exported);
    assertTrue(ConflictException.class.isAssignableFrom(LinkOnlyApprovalException.class));
    assertTrue(PermissionDeniedException.class.isAssignableFrom(SpendCapReachedException.class));
  }

  private static List<String> values(Object[] constants) {
    return Arrays.stream(constants).map(Object::toString).toList();
  }

  @Test
  void enums() {
    assertEquals(SURFACE.get("event_kinds"), values(EventKind.values()));
    assertEquals(SURFACE.get("turn_statuses"), values(TurnStatus.values()));
    assertEquals(SURFACE.get("turn_record_statuses"), values(TurnRecordStatus.values()));
  }
}
