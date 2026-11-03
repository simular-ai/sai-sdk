package ai.simular.sai;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

/**
 * Every Java block in the docs (sai-platform) runs against the mock server's fake API. See
 * ../conformance/README.md#docs-snippets. Each block becomes a class whose {@code main} holds the
 * block (after its context, if it has one); all are compiled in one javac pass, then each runs in
 * its own JVM.
 */
class SnippetsTest {
  private static final boolean REQUIRED = "1".equals(System.getenv("SAI_DOCS_REQUIRED"));
  private static MockServer server;

  @AfterAll
  static void stop() {
    if (server != null) server.close();
  }

  @SuppressWarnings("unchecked")
  @TestFactory
  Stream<DynamicTest> snippets() throws Exception {
    Process extract =
        new ProcessBuilder("node", MockServer.CONFORMANCE.resolve("snippets.mjs").toString(), "--lang", "java")
            .start();
    byte[] out = extract.getInputStream().readAllBytes();
    String err = new String(extract.getErrorStream().readAllBytes(), StandardCharsets.UTF_8);
    if (extract.waitFor() != 0) {
      if (REQUIRED) return Stream.of(DynamicTest.dynamicTest("finds the docs", () -> fail(err)));
      return Stream.empty();
    }
    List<Map<String, Object>> snippets = MockServer.MAPPER.readValue(out, List.class);
    if (snippets.isEmpty()) {
      if (REQUIRED) return Stream.of(DynamicTest.dynamicTest("finds Java blocks", () -> fail("no Java blocks")));
      return Stream.empty();
    }

    Path work = Files.createTempDirectory("sai-java-snippets");
    Path src = Files.createDirectories(work.resolve("src"));
    Path classes = Files.createDirectories(work.resolve("classes"));
    Path cwd = Files.createDirectories(work.resolve("run"));
    copy(MockServer.CONFORMANCE.resolve("fixtures"), cwd);

    Map<String, Map<String, Object>> byClass = new LinkedHashMap<>();
    Map<String, Path> sources = new LinkedHashMap<>();
    for (Map<String, Object> s : snippets) {
      String name = className(s);
      byClass.put(name, s);
      Path file = src.resolve(name + ".java");
      Files.writeString(file, program(name, s));
      sources.put(name, file);
    }
    Map<String, String> errors = compile(sources, classes);
    server = new MockServer();

    List<DynamicTest> tests = new ArrayList<>();
    for (Map.Entry<String, Map<String, Object>> e : byClass.entrySet()) {
      Map<String, Object> s = e.getValue();
      String name = e.getKey();
      tests.add(
          DynamicTest.dynamicTest(
              s.get("file") + ":" + s.get("line"),
              () -> {
                if (errors.containsKey(name)) fail("does not compile:\n" + errors.get(name));
                run(name, classes, cwd);
              }));
    }
    return tests.stream();
  }

  private static String className(Map<String, Object> s) {
    return "Snippet_" + ((String) s.get("file")).replaceAll("\\W", "_") + "_" + s.get("line");
  }

  private static boolean isImport(String line) {
    return line.startsWith("import ");
  }

  /** The block as a class: imports first, then {@code main} with the context and the block in a scope of its own. */
  static String program(String name, Map<String, Object> s) {
    String context = (String) s.getOrDefault("context", "");
    String code = (String) s.get("code");
    Set<String> imports = new LinkedHashSet<>();
    for (String l : (context + "\n" + code).split("\n")) if (isImport(l)) imports.add(l);
    StringBuilder sb = new StringBuilder();
    for (String i : imports) sb.append(i).append('\n');
    sb.append("\npublic class ").append(name).append(" {\n");
    sb.append("  public static void main(String[] args) throws Exception {\n");
    if (context.isEmpty()) {
      sb.append(body(code));
    } else {
      sb.append(body(context)).append("{\n").append(body(code)).append("}\n");
    }
    sb.append("  }\n}\n");
    return sb.toString();
  }

  private static String body(String code) {
    StringBuilder sb = new StringBuilder();
    for (String l : code.split("\n")) if (!isImport(l)) sb.append(l).append('\n');
    return sb.toString();
  }

  /** One javac pass over every snippet; a second over the ones that compiled, if any did not. */
  private static Map<String, String> compile(Map<String, Path> sources, Path classes) throws IOException {
    Map<String, String> errors = new LinkedHashMap<>();
    List<Path> files = new ArrayList<>(sources.values());
    for (int pass = 0; pass < 2 && !files.isEmpty(); pass++) {
      Map<String, String> found = javac(files, classes);
      if (found.isEmpty()) break;
      errors.putAll(found);
      files.removeIf(f -> found.containsKey(f.getFileName().toString().replace(".java", "")));
    }
    return errors;
  }

  private static Map<String, String> javac(List<Path> files, Path classes) throws IOException {
    JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
    DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
    Map<String, String> errors = new LinkedHashMap<>();
    try (StandardJavaFileManager fm = javac.getStandardFileManager(diagnostics, Locale.ROOT, StandardCharsets.UTF_8)) {
      List<String> options =
          List.of("--release", "17", "-proc:none", "-nowarn", "-d", classes.toString(),
              "-cp", System.getProperty("java.class.path"));
      javac.getTask(null, fm, diagnostics, options, null, fm.getJavaFileObjectsFromPaths(files)).call();
    }
    for (Diagnostic<? extends JavaFileObject> d : diagnostics.getDiagnostics()) {
      if (d.getKind() != Diagnostic.Kind.ERROR || d.getSource() == null) continue;
      String name = Path.of(d.getSource().toUri()).getFileName().toString().replace(".java", "");
      errors.merge(
          name,
          "line " + d.getLineNumber() + ": " + d.getMessage(Locale.ROOT) + "\n" + source(d),
          (a, b) -> a + "\n" + b);
    }
    return errors;
  }

  private static String source(Diagnostic<? extends JavaFileObject> d) {
    try {
      String[] lines = d.getSource().getCharContent(true).toString().split("\n");
      long n = d.getLineNumber();
      return n >= 1 && n <= lines.length ? "    " + lines[(int) n - 1].trim() : "";
    } catch (IOException e) {
      return "";
    }
  }

  private static void run(String name, Path classes, Path cwd) throws Exception {
    server.control("reset", Map.of());
    String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
    ProcessBuilder pb =
        new ProcessBuilder(
                java, "-XX:TieredStopAtLevel=1", "-cp",
                classes + File.pathSeparator + System.getProperty("java.class.path"), name)
            .directory(cwd.toFile())
            .redirectErrorStream(true)
            .redirectOutput(cwd.resolve(name + ".log").toFile());
    Map<String, String> env = pb.environment();
    env.put("SAI_API_KEY", "sapi_docs");
    env.put("SAI_ORG_KEY", "sapi_docs_org");
    env.put("SAI_API_URL", server.url);
    env.put("SAI_ORG_ID", "org_docs");
    Process p = pb.start();
    p.getOutputStream().close();
    boolean done = p.waitFor(60, TimeUnit.SECONDS);
    if (!done) p.destroyForcibly().waitFor();
    String output = Files.readString(cwd.resolve(name + ".log"));
    assertTrue(done, "timed out:\n" + output);
    assertEquals(0, p.exitValue(), output);
  }

  private static void copy(Path from, Path to) throws IOException {
    try (Stream<Path> paths = Files.walk(from)) {
      for (Path p : paths.toList()) {
        Path dest = to.resolve(from.relativize(p).toString());
        if (Files.isDirectory(p)) Files.createDirectories(dest);
        else Files.copy(p, dest);
      }
    }
  }
}
