# ai.simular:sai-sdk (Java)

Java SDK for the [Sai API](https://platform.simular.ai/documentation). Hand desktop work to Sai on a
computer (a Sai cloud computer, or your own PC with the Sai app) and get the answer back, or drive a
computer yourself.

Status: **alpha (0.1)**. The surface may still change before 1.0. It matches the
[Python SDK](../python/README.md) and the [TypeScript SDK](../typescript/README.md) method for method.

| Layer              | What it is                                    | Status           |
| ------------------ | --------------------------------------------- | ---------------- |
| `sai.sessions()`   | A conversation with Sai on one computer       | available        |
| `sai.control()`    | Drive a computer (cloud or own) with Simulang | research preview |
| `sai.turns()`      | A turn's record: typed output, evidence       | available        |

## Install

Maven:

```xml
<dependency>
  <groupId>ai.simular</groupId>
  <artifactId>sai-sdk</artifactId>
  <version>0.1.0</version>
</dependency>
```

Gradle:

```kotlin
implementation("ai.simular:sai-sdk:0.1.0")
```

```bash
export SAI_API_KEY=sapi_...   # create one at https://platform.simular.ai
```

Java 17 or later. It uses the JDK's `java.net.http.HttpClient`; its one runtime dependency is Jackson
(`jackson-databind`). Every call blocks until it has its answer; errors are unchecked.

## Give Sai a task

```java
import ai.simular.sai.Machine;
import ai.simular.sai.Sai;
import ai.simular.sai.Session;
import ai.simular.sai.TurnResult;

Sai sai = new Sai();
Machine pc = sai.machines().list().get(0);

Session session = sai.sessions().create(pc);
TurnResult result = session.run("Open Notepad, type hello, save it to the desktop as hello.txt");

System.out.println(result.status()); // idle | needs_approval | error
System.out.println(result.text()); // Sai's answer
System.out.println(result.usage()); // tokens and cost for this task
```

The machine can be left out when the account has one computer. More `session.run(...)` calls continue
the same conversation; `sai.sessions().create()` starts a new one with no memory of the old.
`sai.sessions().list(pc)` lists your sessions on the computer (desktop, CLI and API), most recent
first, and `sai.auth().check()` says who the key acts as.

### Watch it work

```java
Turn turn = session.send("Find last month's invoices in Downloads and total them");
for (Event ev : turn.events()) {
  if (ev.kind() == EventKind.STEP) System.out.println("   " + ev.text());
  else if (ev.kind() == EventKind.APPROVAL) turn.respond(ev.approval(), "yes");
}
TurnResult result = turn.waitFor();
```

`ev.kind()` is one of `STEP`, `MESSAGE`, `APPROVAL`, `TOOL_ERROR`, `ERROR`, `FINISHED`; `value()` is
the name every SDK uses (`tool_error`). `turn.events(new EventsOptions().raw(true))` adds the wire
frames (reasoning, tool calls) as `OTHER`. The events are polled as you iterate.

`wait` is `waitFor` in Java (`Object.wait()` is final): `turn.waitFor()`, `sai.turns().waitFor(turn)`,
`sai.learn().waitFor(job)`.

### Approvals

`run()` / `waitFor()` return with status `NEEDS_APPROVAL` unless you pass a handler:

```java
TurnResult result = session.run("Clean up the temp folder", new WaitOptions().onApproval(a -> {
  if (a.isLinkOnly()) {
    System.out.println("Approve in a browser: " + a.url());
    return null; // a person answers it; keep waiting
  }
  return ApprovalAnswer.of("yes"); // or ApprovalAnswer.of("yes", selections) for a choice
}));
```

For an unattended run with nobody to answer, `autonomous(true)` runs the turn without approval cards,
as if `"task"` (trust for the rest of the task) had been answered up front. The grant ends with the
turn. Approvals that only a person can complete in a browser (`isLinkOnly()`) still stop the turn.

```java
session.run("Export last month's invoices to CSV", new SendOptions().autonomous(true));
```

`run(message, SendOptions, WaitOptions)` takes both.

### Files, models, stopping

```java
Attachment report = sai.files().upload(Path.of("report.pdf")); // or upload(bytes, "report.pdf")
session.run("Summarise the attached report", new SendOptions().attachments(List.of(report)));

List<String> allowed = sai.models().list().stream().filter(Model::allowed).map(Model::id).toList();
session.run("...", new SendOptions().model("anthropic/claude-opus-5-5")); // sticks to the session

Turn turn = session.send("...");
turn.abort();
```

### Let a person take over

When Sai needs a person (a sign-in, a captcha), `machines().live()` returns `liveUrl()`: a page with the
computer's screen that anyone with the link can open, no Simular account needed.

```java
LiveView view = sai.machines().live(pc);
System.out.println("Sign in here, then tell me: " + view.liveUrl()); // valid until view.expiresAt() (ms)
// ... once they are done
session.run("I signed in. Carry on.");
sai.machines().revokeLive(pc); // every open link stops working
```

## Get typed results

Pass `outputSchema` and the turn's record comes back in `result.record()`, with `output()` matching the
schema:

```java
TurnResult result = session.run(
    "Open Notepad, type \"hello\" and save it on the Desktop as hello.txt. Return the saved file's path.",
    new SendOptions().outputSchema(Map.of(
        "type", "object",
        "properties", Map.of("path", Map.of("type", "string")),
        "required", List.of("path"))));
if (result.ok()) System.out.println(((Map<?, ?>) result.record().output()).get("path"));
else System.out.println(result.record().reasonCode()); // e.g. output_invalid, with rawAnswer()
```

`SendOptions` also takes `inputs`, `successCriteria` (a string, or `List<Check>`), `idempotencyKey`,
`recordTrajectory` and `thinkingLevel`. `inputs`, `outputSchema` or `successCriteria` make the message
_structured_; it is rejected with `ConflictException` (`code()` is `session_busy`) while the session is
working.

**Reading a turn later.** Every message gets a turn id, `turn.id()`:

```java
Turn turn = session.send("...", new SendOptions().recordTrajectory(true));
TurnRecord record = sai.turns().get(turn); // never waits; finalizing while the result is worked out
record = sai.turns().waitFor(turn, Duration.ofMinutes(10)); // until succeeded, failed or needs_input
for (TrajectoryStep step : sai.turns().trajectory(turn)) {
  System.out.println(step.index() + " " + step.title() + " " + step.code());
  if (step.hasScreenshot()) {
    Files.write(Path.of("step" + step.index() + ".jpg"), sai.turns().screenshot(turn, step.index()));
  }
}
```

Each takes a `Turn`, a `TurnRecord` or the id string.

## Drive a computer yourself

Direct control runs [Simulang](https://platform.simular.ai/documentation/concepts/direct-control)
blocks on one of your computers, cloud or your own. While the lease is open, Sai's own tasks on that
computer wait, so always close it: `ControlLease` is `AutoCloseable`.

```java
try (ControlLease lease = sai.control().open(pc)) {
  System.out.println(lease.shell("hostname").stdout());

  ExecResult r = lease.exec("""
      var page = await machine.browser.newtab('https://example.com')
      var snap = await page.snapshot()
      snap.title
      """);
  System.out.println(r.result()); // Example Domain
}
```

`exec()` returns an `ExecResult`; a block that threw still returns, so check `r.error()`. Use `var`,
not `let`/`const`, for values the next block needs. `lease.screenshot()` grabs the whole screen and
throws `BlockException` where the screen-capture service is off.

## Learn code from turns (research preview)

```java
LearnResult learned = sai.learn().create(List.of(turn)); // the turns were sent with recordTrajectory
try (ControlLease lease = sai.control().open(pc)) {
  ExecResult r = lease.run(learned, Map.of("site", "https://lobste.rs")); // inputs over the defaults
  if (!r.ok()) {
    LearnResult fixed = sai.learn().create(List.of(), new LearnOptions()
        .initialCode(learned.code())
        .evaluations(List.of(new Evaluation(Map.of("site", "https://lobste.rs")).result(r).passed(false))));
  }
}

LearnResult job = sai.learn().create(List.of(), new LearnOptions()
    .taskTemplate("Open {{site}} and read the title of the top story")
    .inputs(Map.of("site", "https://news.ycombinator.com"))
    .machine(pc)
    .maxIterations(3)
    .rollouts(3));
LearnResult done = sai.learn().waitFor(job); // can take an hour
Judgement judgement = sai.judge().create(List.of(turn), List.of(new Check("title", "The agent reported a story title")));
```

## Run Sai for your customers

```java
Sai org = Sai.builder().apiKey("sapi_...").orgId("org_...").build(); // or SAI_API_KEY, SAI_ORG_ID

Tenant tenant = org.tenants().create("Riverside Clinic", new CreateTenantOptions().externalId("clinic-4821"));
Enrollment code = org.tenants().createEnrollment(tenant); // hand code.token() to your installer
System.out.println(org.tenantMachines().list(tenant));

Sai clinic = org.tenants().client(tenant); // acts as the Tenant; renews its token
clinic.sessions().create().run("Open the calendar and read today's appointments");

TenantMachine machine = org.tenantMachines().create(tenant, "windows", new CreateMachineOptions()
    .requestId(UUID.randomUUID().toString())
    .waitForReady(true)); // wait in the other SDKs

OrgUsage usage = org.usage().get(new UsageOptions().granularity("month").from("2026-10").to("2026-10"));
```

To charge for a task as soon as it ends, look its session up in real time instead of a date range:

```java
SessionSpendPage page = org.usage().sessions(tenant, new SessionSpendOptions().sessionIds(session.id()));
for (SessionSpend s : page.sessions()) {
  if (Boolean.TRUE.equals(s.settled())) {
    System.out.println(s.sessionId() + " " + s.costUsd() + " " + page.asOf());
  }
}
```

With `sessionIds` (1 to 50 of the Tenant's sessions) each session comes back with its spend so far and
`settled()`: true once its latest task has ended and every charge for it has come in. Ask again every
10 seconds or so until it is. `costUsd()` and `modelCalls()` are null when the session can't be read
in full right now. An id that is not one of the Tenant's sessions is left out. See
[Session spend](https://platform.simular.ai/documentation/organisations/session-spend) for the limits.

## Errors

Every non-2xx response throws an unchecked `SaiException` subclass with `status()`, `code()`,
`getMessage()`, `body()` and `retryAfter()`. The names map from the other SDKs' (`NotFoundError` is
`NotFoundException`; `ConnectionError` is `SaiConnectionException`):

`AuthenticationException` (401), `BadRequestException` (400), `PermissionDeniedException` (403),
`NotFoundException` (404), `ConflictException` (409), `LinkOnlyApprovalException` (`approvalUrl()`),
`GoneException` (410), `SpendCapReachedException` (403; `resetsAt()`), `RateLimitException` (429),
`ServiceUnavailableException` (503), `SaiConnectionException`, `BlockException`.

A wait past its timeout throws `SaiTimeoutException`, which is not an API error.

## Configuration

| Builder method | Env           | Default                  |
| -------------- | ------------- | ------------------------ |
| `apiKey`       | `SAI_API_KEY` | required                 |
| `baseUrl`      | `SAI_API_URL` | `https://api.simular.ai` |
| `timeout`      |               | 60 s per request         |
| `versionTag`   |               | the current API          |
| `httpClient`   |               | a new `HttpClient`       |
| `orgId`        | `SAI_ORG_ID`  | for `tenants().token()`  |

## Development

```bash
cd java
mvn -B verify   # parity with surface.json, the conformance cases, the docs' Java snippets
```

The tests start the mock server with `node`, so Node 18 or later must be on `PATH`. The docs snippets
are read from `../sai-platform/src/docs/content` (or `SAI_DOCS_DIR`) and skipped when missing, unless
`SAI_DOCS_REQUIRED=1`.
