package ai.simular.sai;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

/**
 * The shared conformance suite (../conformance/README.md): each case's steps become calls on this
 * SDK, against the mock server, which checks the requests and the outcomes.
 */
class ConformanceTest {
  private static MockServer server;

  @BeforeAll
  static void start() throws IOException {
    server = new MockServer();
  }

  @AfterAll
  static void stop() {
    if (server != null) server.close();
  }

  @SuppressWarnings("unchecked")
  static List<Map<String, Object>> cases() throws IOException {
    List<Map<String, Object>> out = new ArrayList<>();
    try (Stream<Path> files = Files.list(MockServer.CONFORMANCE.resolve("cases"))) {
      for (Path f : files.filter(p -> p.toString().endsWith(".json")).sorted().toList()) {
        Map<String, Object> file = MockServer.MAPPER.readValue(f.toFile(), Map.class);
        out.addAll((List<Map<String, Object>>) file.get("cases"));
      }
    }
    return out;
  }

  @TestFactory
  Stream<DynamicTest> conformance() throws IOException {
    return cases().stream().map(c -> DynamicTest.dynamicTest((String) c.get("id"), () -> run(c)));
  }

  @SuppressWarnings("unchecked")
  private static void run(Map<String, Object> c) throws Exception {
    server.control("start", Map.of("case", c.get("id")));
    Map<String, Object> client = (Map<String, Object>) c.getOrDefault("client", Map.of());
    Sai sai =
        Sai.builder()
            .apiKey((String) client.getOrDefault("api_key", "sapi_test"))
            .baseUrl(server.url)
            .orgId((String) client.getOrDefault("org_id", ""))
            .versionTag((String) client.get("version_tag"))
            .build();
    Map<String, Object> saved = new LinkedHashMap<>();
    saved.put("client", sai);
    List<Map<String, Object>> steps = (List<Map<String, Object>>) c.get("steps");
    for (int index = 0; index < steps.size(); index++) {
      Map<String, Object> step = steps.get(index);
      Map<String, Object> outcome = new LinkedHashMap<>();
      outcome.put("index", index);
      try {
        Object value = Dispatch.invoke(saved, step);
        outcome.put("result", Projection.project(value));
        String save = (String) step.get("save");
        if (save != null) {
          String pick = (String) step.get("pick");
          saved.put(save, pick == null ? value : Projection.pick(value, pick));
        }
      } catch (Throwable err) {
        outcome.put("error", Projection.projectError(err));
      }
      server.control("step", outcome);
    }
    Map<String, Object> finish = server.control("finish", Map.of());
    assertEquals(List.of(), finish.get("failures"));
  }

  /** The calls of the README's call table, on this SDK. */
  static final class Dispatch {
    private Dispatch() {}

    @SuppressWarnings("unchecked")
    static Object invoke(Map<String, Object> saved, Map<String, Object> step) {
      String[] parts = ((String) step.get("call")).split("\\.");
      String first = parts[0];
      Object target;
      String method;
      if (saved.containsKey(first) && !first.equals("client")) {
        target = saved.get(first);
        method = String.join(".", List.of(parts).subList(1, parts.length));
      } else {
        target = saved.get("client");
        method = String.join(".", parts);
      }
      Map<String, Object> a =
          (Map<String, Object>) resolve(saved, step.getOrDefault("args", Map.of()));
      if (target instanceof Sai s) return client(s, method, a);
      if (target instanceof Session s) return session(s, method, a);
      if (target instanceof Turn t) return turn(t, method, a);
      if (target instanceof ControlLease l) return lease(l, method, a);
      throw new IllegalStateException("no target for " + step.get("call"));
    }

    /** {@code { $ref }} → the saved object, everywhere in the arguments. */
    @SuppressWarnings("unchecked")
    private static Object resolve(Map<String, Object> saved, Object v) {
      if (v instanceof List<?> l) {
        List<Object> out = new ArrayList<>();
        for (Object x : l) out.add(resolve(saved, x));
        return out;
      }
      if (v instanceof Map<?, ?> m) {
        Map<String, Object> o = (Map<String, Object>) m;
        if (o.get("$ref") instanceof String ref) {
          if (!saved.containsKey(ref)) throw new IllegalStateException("nothing saved as " + ref);
          return saved.get(ref);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        o.forEach((k, x) -> out.put(k, resolve(saved, x)));
        return out;
      }
      return v;
    }

    private static String str(Map<String, Object> a, String key) {
      return (String) a.get(key);
    }

    private static int num(Map<String, Object> a, String key) {
      return ((Number) a.get(key)).intValue();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Map<String, Object> a, String key) {
      return (Map<String, Object>) a.get(key);
    }

    @SuppressWarnings("unchecked")
    private static List<Check> checks(Object v) {
      List<Check> out = new ArrayList<>();
      for (Map<String, Object> c : (List<Map<String, Object>>) v) {
        out.add(new Check((String) c.get("id"), (String) c.get("check"), (Boolean) c.get("return_evidence")));
      }
      return out;
    }

    @SuppressWarnings("unchecked")
    private static SendOptions send(Map<String, Object> a) {
      SendOptions o = new SendOptions();
      if (a.containsKey("model")) o.model(str(a, "model"));
      if (a.containsKey("attachments")) o.attachments((List<Attachment>) a.get("attachments"));
      if (a.containsKey("inputs")) o.inputs(map(a, "inputs"));
      if (a.containsKey("output_schema")) o.outputSchema(map(a, "output_schema"));
      if (a.get("success_criteria") instanceof String s) o.successCriteria(s);
      else if (a.containsKey("success_criteria")) o.successCriteria(checks(a.get("success_criteria")));
      if (a.containsKey("idempotency_key")) o.idempotencyKey(str(a, "idempotency_key"));
      if (a.containsKey("record_trajectory")) o.recordTrajectory((Boolean) a.get("record_trajectory"));
      if (a.containsKey("thinking_level")) o.thinkingLevel(str(a, "thinking_level"));
      if (a.containsKey("autonomous")) o.autonomous((Boolean) a.get("autonomous"));
      return o;
    }

    @SuppressWarnings("unchecked")
    private static WaitOptions waitOpts(Map<String, Object> a) {
      WaitOptions o = new WaitOptions();
      if (a.containsKey("poll_wait")) o.pollWait(Duration.ofSeconds(num(a, "poll_wait")));
      if (a.get("on_approval") instanceof Map<?, ?> handler) {
        List<Object> answers = new ArrayList<>((List<Object>) handler.get("answers"));
        o.onApproval(
            approval -> {
              if (answers.isEmpty()) return null;
              Object answer = answers.remove(0);
              if (answer == null) return null;
              if (answer instanceof String s) return ApprovalAnswer.of(s);
              List<Object> pair = (List<Object>) answer;
              return ApprovalAnswer.of((String) pair.get(0), (List<List<String>>) pair.get(1));
            });
      }
      return o;
    }

    private static Duration millis(Map<String, Object> a, String key) {
      return a.containsKey(key) ? Duration.ofMillis(((Number) a.get(key)).longValue()) : null;
    }

    private static String machineId(Object m) {
      return m instanceof Machine x ? x.id() : (String) m;
    }

    private static String tenantId(Object t) {
      return t instanceof Tenant x ? x.id() : (String) t;
    }

    @SuppressWarnings("unchecked")
    private static Object client(Sai sai, String method, Map<String, Object> a) {
      Object machine = a.get("machine");
      Object tenant = a.get("tenant");
      Object turn = a.get("turn");
      Object job = a.get("job");
      switch (method) {
        case "machines.list":
          return sai.machines().list();
        case "machines.get":
          return sai.machines().get(str(a, "machine_id"));
        case "machines.live":
          return machine instanceof Machine m ? sai.machines().live(m) : sai.machines().live((String) machine);
        case "machines.revoke_live":
          return machine instanceof Machine m
              ? sai.machines().revokeLive(m)
              : sai.machines().revokeLive((String) machine);
        case "sessions.create":
          if (machine == null) return sai.sessions().create();
          return machine instanceof Machine m ? sai.sessions().create(m) : sai.sessions().create((String) machine);
        case "sessions.resume":
          if (machine == null) return sai.sessions().resume(str(a, "session_id"));
          return sai.sessions().resume(str(a, "session_id"), machineId(machine));
        case "sessions.list":
          if (machine == null) return sai.sessions().list();
          return sai.sessions().list(machineId(machine));
        case "turns.get":
          return turn instanceof TurnRef t ? sai.turns().get(t) : sai.turns().get((String) turn);
        case "turns.wait":
          return turn instanceof TurnRef t ? sai.turns().waitFor(t) : sai.turns().waitFor((String) turn);
        case "turns.trajectory":
          return turn instanceof TurnRef t ? sai.turns().trajectory(t) : sai.turns().trajectory((String) turn);
        case "turns.screenshot":
          return turn instanceof TurnRef t
              ? sai.turns().screenshot(t, num(a, "index"))
              : sai.turns().screenshot((String) turn, num(a, "index"));
        case "learn.create":
          return sai.learn().create((List<Object>) a.get("turns"), learnOpts(a));
        case "learn.get":
          return sai.learn().get(str(a, "learn_id"));
        case "learn.wait": {
          Duration poll = millis(a, "poll_ms");
          return job instanceof LearnResult j
              ? sai.learn().waitFor(j, null, poll)
              : sai.learn().waitFor((String) job, null, poll);
        }
        case "learn.cancel":
          if (job instanceof LearnResult j) sai.learn().cancel(j);
          else sai.learn().cancel((String) job);
          return null;
        case "learn.rollout":
          return job instanceof LearnResult j
              ? sai.learn().rollout(j, num(a, "iteration"), num(a, "rollout"))
              : sai.learn().rollout((String) job, num(a, "iteration"), num(a, "rollout"));
        case "judge.create": {
          JudgeOptions o = new JudgeOptions();
          if (a.containsKey("task")) o.task(str(a, "task"));
          if (a.containsKey("idempotency_key")) o.idempotencyKey(str(a, "idempotency_key"));
          List<Object> turns = (List<Object>) a.get("turns");
          return a.get("criteria") instanceof String s
              ? sai.judge().create(turns, s, o)
              : sai.judge().create(turns, checks(a.get("criteria")), o);
        }
        case "judge.get":
          return sai.judge().get(str(a, "judgement_id"));
        case "control.open":
          return machine instanceof Machine m ? sai.control().open(m) : sai.control().open((String) machine);
        case "models.list":
          return sai.models().list();
        case "files.upload":
          return sai.files().upload(Base64.getDecoder().decode(str(a, "data_base64")), str(a, "name"));
        case "account.get":
          return sai.account().get();
        case "auth.check":
          return sai.auth().check();
        case "usage.get": {
          UsageOptions o = new UsageOptions();
          if (a.containsKey("granularity")) o.granularity(str(a, "granularity"));
          if (a.containsKey("from")) o.from(str(a, "from"));
          if (a.containsKey("to")) o.to(str(a, "to"));
          if (a.containsKey("org_id")) o.orgId(str(a, "org_id"));
          return sai.usage().get(o);
        }
        case "usage.sessions": {
          SessionSpendOptions o = new SessionSpendOptions();
          if (a.containsKey("limit")) o.limit(num(a, "limit"));
          if (a.containsKey("cursor")) o.cursor(str(a, "cursor"));
          if (a.containsKey("org_id")) o.orgId(str(a, "org_id"));
          return tenant instanceof Tenant t
              ? sai.usage().sessions(t, str(a, "from"), str(a, "to"), o)
              : sai.usage().sessions((String) tenant, str(a, "from"), str(a, "to"), o);
        }
        case "tenants.create": {
          CreateTenantOptions o = new CreateTenantOptions();
          if (a.containsKey("external_id")) o.externalId(str(a, "external_id"));
          if (a.containsKey("metadata")) o.metadata((Map<String, String>) a.get("metadata"));
          return sai.tenants().create(str(a, "name"), o);
        }
        case "tenants.list": {
          ListTenantsOptions o = new ListTenantsOptions();
          if (a.containsKey("status")) o.status(str(a, "status"));
          if (a.containsKey("external_id")) o.externalId(str(a, "external_id"));
          if (a.containsKey("limit")) o.limit(num(a, "limit"));
          if (a.containsKey("cursor")) o.cursor(str(a, "cursor"));
          return sai.tenants().list(o);
        }
        case "tenants.get":
          return tenant instanceof Tenant t ? sai.tenants().get(t) : sai.tenants().get((String) tenant);
        case "tenants.update": {
          UpdateTenantOptions o = new UpdateTenantOptions();
          if (a.containsKey("name")) o.name(str(a, "name"));
          if (a.containsKey("metadata")) o.metadata((Map<String, String>) a.get("metadata"));
          if (a.containsKey("status")) o.status(str(a, "status"));
          if (a.containsKey("cloud_machine_limit")) {
            Number n = (Number) a.get("cloud_machine_limit");
            o.cloudMachineLimit(n == null ? null : n.intValue());
          }
          if (a.containsKey("residential_proxy")) o.residentialProxy((Boolean) a.get("residential_proxy"));
          return sai.tenants().update(tenantId(tenant), o);
        }
        case "tenants.delete":
          if (tenant instanceof Tenant t) sai.tenants().delete(t);
          else sai.tenants().delete((String) tenant);
          return null;
        case "tenants.create_enrollment":
          return tenant instanceof Tenant t
              ? sai.tenants().createEnrollment(t)
              : sai.tenants().createEnrollment((String) tenant);
        case "tenants.token":
          return sai.tenants().token(tenantId(tenant), str(a, "org_id"));
        case "tenants.client":
          return sai.tenants().client(tenantId(tenant), str(a, "org_id"));
        case "tenant_machines.create": {
          CreateMachineOptions o = new CreateMachineOptions();
          if (a.containsKey("name")) o.name(str(a, "name"));
          if (a.containsKey("request_id")) o.requestId(str(a, "request_id"));
          if (a.containsKey("wait")) o.waitForReady((Boolean) a.get("wait"));
          return sai.tenantMachines().create(tenantId(tenant), str(a, "os"), o);
        }
        case "tenant_machines.list":
          return sai.tenantMachines().list(tenantId(tenant));
        case "tenant_machines.get":
          return sai.tenantMachines().get(tenantId(tenant), str(a, "machine_id"));
        case "tenant_machines.delete":
          return machine instanceof TenantMachine m
              ? sai.tenantMachines().delete(tenantId(tenant), m)
              : sai.tenantMachines().delete(tenantId(tenant), (String) machine);
        case "tenant_machines.revoke":
          if (machine instanceof TenantMachine m) sai.tenantMachines().revoke(tenantId(tenant), m);
          else sai.tenantMachines().revoke(tenantId(tenant), (String) machine);
          return null;
        default:
          throw new IllegalStateException("unknown call client." + method);
      }
    }

    @SuppressWarnings({"unchecked", "deprecation"})
    private static LearnOptions learnOpts(Map<String, Object> a) {
      LearnOptions o = new LearnOptions();
      if (a.containsKey("task_template")) o.taskTemplate(str(a, "task_template"));
      if (a.containsKey("inputs")) o.inputs(map(a, "inputs"));
      if (a.containsKey("initial_code")) o.initialCode(str(a, "initial_code"));
      if (a.containsKey("guidance")) o.guidance(str(a, "guidance"));
      if (a.containsKey("history")) o.history(str(a, "history"));
      if (a.containsKey("runs_without_reset")) o.runsWithoutReset((Boolean) a.get("runs_without_reset"));
      if (a.containsKey("max_iterations")) o.maxIterations(num(a, "max_iterations"));
      if (a.containsKey("rollouts")) o.rollouts(num(a, "rollouts"));
      if (a.get("machine") instanceof Machine m) o.machine(m);
      else if (a.containsKey("machine")) o.machine(str(a, "machine"));
      if (a.containsKey("reset")) o.reset(map(a, "reset"));
      if (a.containsKey("judge_initial_agent_run")) o.judgeInitialAgentRun((Boolean) a.get("judge_initial_agent_run"));
      if (a.containsKey("continue_with_agent")) o.continueWithAgent((Boolean) a.get("continue_with_agent"));
      if (a.containsKey("rollout_minutes")) o.rolloutMinutes(num(a, "rollout_minutes"));
      if (a.containsKey("agent_run_minutes")) o.agentRunMinutes(num(a, "agent_run_minutes"));
      if (a.containsKey("continuation_minutes")) o.continuationMinutes(num(a, "continuation_minutes"));
      if (a.containsKey("max_job_minutes")) o.maxJobMinutes(num(a, "max_job_minutes"));
      if (a.containsKey("model")) o.model(str(a, "model"));
      if (a.containsKey("idempotency_key")) o.idempotencyKey(str(a, "idempotency_key"));
      if (a.get("criteria") instanceof String s) o.criteria(s);
      else if (a.containsKey("criteria")) o.criteria(checks(a.get("criteria")));
      if (a.containsKey("evaluations")) {
        List<Evaluation> evals = new ArrayList<>();
        for (Map<String, Object> e : (List<Map<String, Object>>) a.get("evaluations")) {
          Evaluation ev = new Evaluation((Map<String, Object>) e.get("inputs"));
          if (e.get("result") != null) ev.result((ExecResult) e.get("result"));
          if (e.get("judgement") instanceof Judgement j) ev.judgement(j);
          else if (e.get("judgement") != null) ev.judgement((String) e.get("judgement"));
          if (e.get("passed") != null) ev.passed((Boolean) e.get("passed"));
          if (e.get("note") != null) ev.note((String) e.get("note"));
          evals.add(ev);
        }
        o.evaluations(evals);
      }
      return o;
    }

    @SuppressWarnings("unchecked")
    private static Object respond(Session s, Map<String, Object> a) {
      Object approval = a.get("approval");
      String response = a.containsKey("response") ? str(a, "response") : "yes";
      List<List<String>> selections = (List<List<String>>) a.get("selections");
      return approval instanceof Approval ap
          ? s.respond(ap, response, selections)
          : s.respond((String) approval, response, selections);
    }

    private static Object session(Session s, String method, Map<String, Object> a) {
      switch (method) {
        case "send":
          return s.send(str(a, "message"), send(a));
        case "run":
          return s.run(str(a, "message"), send(a), waitOpts(a));
        case "abort":
          return s.abort();
        case "respond":
          return respond(s, a);
        default:
          throw new IllegalStateException("unknown call Session." + method);
      }
    }

    private static Object turn(Turn t, String method, Map<String, Object> a) {
      switch (method) {
        case "events": {
          EventsOptions o = new EventsOptions();
          if (a.containsKey("raw")) o.raw((Boolean) a.get("raw"));
          if (a.containsKey("poll_wait")) o.pollWait(Duration.ofSeconds(num(a, "poll_wait")));
          List<Event> out = new ArrayList<>();
          for (Event ev : t.events(o)) out.add(ev);
          return out;
        }
        case "wait":
          return t.waitFor(waitOpts(a));
        case "respond":
          return respond(t.session(), a);
        case "abort":
          return t.abort();
        default:
          throw new IllegalStateException("unknown call Turn." + method);
      }
    }

    @SuppressWarnings("unchecked")
    private static Object lease(ControlLease l, String method, Map<String, Object> a) {
      switch (method) {
        case "exec":
          return l.exec(str(a, "code"), millis(a, "timeout_ms"));
        case "run": {
          Map<String, Object> inputs = (Map<String, Object>) a.getOrDefault("inputs", Map.of());
          return a.get("learned") instanceof LearnResult learned
              ? l.run(learned, inputs, millis(a, "timeout_ms"))
              : l.run(str(a, "learned"), inputs, millis(a, "timeout_ms"));
        }
        case "shell":
          return l.shell(str(a, "command"), str(a, "cwd"), millis(a, "timeout_ms"));
        case "read_file":
          return l.readFile(str(a, "path"));
        case "write_file":
          l.writeFile(str(a, "path"), str(a, "text"));
          return null;
        case "screenshot":
          return l.screenshot();
        case "interrupt":
          return l.interrupt();
        case "get":
          return new Projection.Opaque(l.get());
        case "close":
          l.close();
          return null;
        default:
          throw new IllegalStateException("unknown call ControlLease." + method);
      }
    }
  }
}
