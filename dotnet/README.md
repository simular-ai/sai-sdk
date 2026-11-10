# Simular.Sai (.NET)

.NET SDK for the [Sai API](https://platform.simular.ai/documentation). Hand desktop work to Sai on a
computer (a Sai cloud computer, or your own PC with the Sai app) and get the answer back, or drive a
computer yourself.

Status: **alpha (0.1)**. The surface may still change before 1.0. It matches the
[Python SDK](../python/README.md) and the [TypeScript SDK](../typescript/README.md) method for method.

| Layer          | What it is                                    | Status           |
| -------------- | --------------------------------------------- | ---------------- |
| `sai.Sessions` | A conversation with Sai on one computer       | available        |
| `sai.Control`  | Drive a computer (cloud or own) with Simulang | research preview |
| `sai.Turns`    | A turn's record: typed output, evidence       | available        |

## Install

```bash
dotnet add package Simular.Sai
export SAI_API_KEY=sapi_...   # create one at https://platform.simular.ai
```

.NET 8 or later. No dependencies beyond the .NET libraries (`HttpClient`, `System.Text.Json`). Every
call that goes to the API is `async`, ends in `Async` and takes an optional `CancellationToken`.

## Give Sai a task

```csharp
using Simular.Sai;

var sai = new SaiClient(); // SAI_API_KEY, and SAI_API_URL if set
var pc = (await sai.Machines.ListAsync())[0];

var session = await sai.Sessions.CreateAsync(machine: pc);
var result = await session.RunAsync("Open Notepad, type hello, save it to the desktop as hello.txt");

Console.WriteLine(result.Status); // idle | needs_approval | error
Console.WriteLine(result.Text); // Sai's answer
Console.WriteLine(result.Usage); // tokens and cost for this task
```

`machine` can be left out when the account has one computer. More `session.RunAsync(...)` calls
continue the same conversation; `sai.Sessions.CreateAsync()` starts a new one with no memory of the
old. `sai.Sessions.ListAsync(machine: pc)` lists your sessions on the computer (desktop, CLI and
API), most recent first, and `sai.Auth.CheckAsync()` says who the key acts as.

A machine, Tenant, turn or learn job argument takes the object or its id string.

### Watch it work

```csharp
var turn = await session.SendAsync("Find last month's invoices in Downloads and total them");
await foreach (var ev in turn.EventsAsync())
{
    if (ev.Kind == EventKind.Step) Console.WriteLine($"   {ev.Text}");
    else if (ev.Kind == EventKind.Approval) await turn.RespondAsync(ev.Approval!, "yes");
}
var answer = await turn.WaitAsync();
```

`ev.Kind` is one of `step`, `message`, `approval`, `tool_error`, `error`, `finished` (constants on
`EventKind`). `turn.EventsAsync(raw: true)` adds the wire frames (reasoning, tool calls) as `other`.

### Approvals

`RunAsync()` / `WaitAsync()` return with `Status == "needs_approval"` unless you pass a handler:

```csharp
var cleaned = await session.RunAsync("Clean up the temp folder", new RunOptions
{
    OnApproval = a =>
    {
        if (a.IsLinkOnly)
        {
            Console.WriteLine($"Approve in a browser: {a.Url}");
            return null; // a person answers it; keep waiting
        }
        if (a.Type == "choice")
            return new ApprovalAnswer("yes", a.Questions
                .Select(q => new[] { q.GetProperty("options")[0].GetProperty("value").GetString()! })
                .ToArray());
        return "yes";
    },
});
```

`OnApprovalAsync` takes a handler that awaits. For an unattended run with nobody to answer,
`Autonomous = true` runs the turn without approval cards, as if `"task"` (trust for the rest of the
task) had been answered up front. The grant ends with the turn. Approvals that only a person can
complete in a browser (`IsLinkOnly`) still stop the turn.

```csharp
await session.RunAsync("Export last month's invoices to CSV", new RunOptions { Autonomous = true });
```

### Files, models, stopping

```csharp
var report = await sai.Files.UploadAsync("report.pdf"); // or UploadAsync(bytes, "report.pdf")
await session.RunAsync("Summarise the attached report", new RunOptions { Attachments = [report] });

var allowed = (await sai.Models.ListAsync()).Where(m => m.Allowed).Select(m => m.Id).ToList();
await session.RunAsync("...", new RunOptions { Model = "anthropic/claude-opus-5-5" }); // sticks to the session

var running = await session.SendAsync("...");
await running.AbortAsync();
```

### Let a person take over

When Sai needs a person (a sign-in, a captcha), `Machines.LiveAsync` returns `LiveUrl`: a page with
the computer's screen that anyone with the link can open, no Simular account needed.

```csharp
var view = await sai.Machines.LiveAsync(pc);
Console.WriteLine($"Sign in here, then tell me: {view.LiveUrl}"); // valid until view.ExpiresAt (ms)
// ... once they are done
await session.RunAsync("I signed in. Carry on.");
await sai.Machines.RevokeLiveAsync(pc); // every open link stops working
```

## Get typed results

Set `OutputSchema` (a `JsonNode`, or any object `System.Text.Json` serializes) and the turn's record
comes back in `result.Record`, with `Output` matching the schema:

```csharp
var typed = await session.RunAsync(
    "Open Notepad, type \"hello\" and save it on the Desktop as hello.txt. Return the saved file's path.",
    new RunOptions
    {
        OutputSchema = new { type = "object", properties = new { path = new { type = "string" } }, required = new[] { "path" } },
    });
if (typed.Ok) Console.WriteLine(typed.Record?.Output?.GetProperty("path").GetString());
else Console.WriteLine(typed.Record?.ReasonCode); // e.g. output_invalid, with typed.Record.RawAnswer
```

| Option             | What it does                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `Inputs`           | Fill `{{name}}` placeholders in the message; every placeholder needs a value                  |
| `OutputSchema`     | JSON Schema (at most 32 KB) the output must match                                             |
| `SuccessCriteria`  | A guideline for a judge (a string), or an array of `Check(Id, Text, ReturnEvidence)`          |
| `IdempotencyKey`   | The same key again returns the earlier turn and sends nothing                                 |
| `RecordTrajectory` | Keep a screenshot and the action for each step                                                |
| `ThinkingLevel`    | `off`, `low`, `medium`, `high` or `xhigh` for this turn; omitted, the account setting applies |

`Inputs`, `OutputSchema` or `SuccessCriteria` make the message _structured_; it is rejected with
`ConflictException` (`Code == "session_busy"`) while the session is working. `result.Ok` is true only
when the turn succeeded. On `failed`, `Record.ReasonCode` says why.

**Reading a turn later.** Every message gets a turn id, `turn.Id`:

```csharp
var later = await session.SendAsync("...", new SendOptions { RecordTrajectory = true });
var record = await sai.Turns.WaitAsync(later, TimeSpan.FromMinutes(10)); // until succeeded, failed or needs_input
foreach (var step in await sai.Turns.TrajectoryAsync(later))
{
    Console.WriteLine($"{step.Index} {step.Title} {step.Code}");
    if (step.HasScreenshot)
        await File.WriteAllBytesAsync($"step{step.Index}.jpg", await sai.Turns.ScreenshotAsync(later, step.Index));
}
```

## Drive a computer yourself

Direct control runs [Simulang](https://platform.simular.ai/documentation/concepts/direct-control)
blocks on one of your computers, cloud or your own. While the lease is open, Sai's own tasks on that
computer wait, so always close it: `ControlLease` is `IAsyncDisposable`.

```csharp
await using (var lease = await sai.Control.OpenAsync(pc))
{
    Console.WriteLine((await lease.ShellAsync("hostname")).Stdout);

    var r = await lease.ExecAsync("""
        var page = await machine.browser.newtab('https://example.com')
        var snap = await page.snapshot()
        snap.title
        """);
    Console.WriteLine(r.Result); // Example Domain
    await File.WriteAllBytesAsync($"page.{r.ScreenshotMimeType!.Split('/')[1]}", r.Screenshot!); // jpeg or png
}
```

`ExecAsync()` returns an `ExecResult`; a block that threw still returns, so check `r.Error`
(`exception`, `timeout`, `interrupted`). Use `var`, not `let`/`const`, for values the next block needs.
`lease.ScreenshotAsync()` grabs the whole screen; where the computer's screen-capture service is off
it throws `BlockException`.

## Learn code from turns (research preview)

`sai.Learn` turns what the agent did into Simulang code you own, and repairs that code when it breaks.
`sai.Judge` checks recorded turns against criteria you choose afterwards.

```csharp
var recorded = await session.SendAsync("Open {{site}} and read the title of the top story", new SendOptions
{
    Inputs = new Dictionary<string, object> { ["site"] = "https://news.ycombinator.com" },
    RecordTrajectory = true,
});
await sai.Turns.WaitAsync(recorded);

var learned = await sai.Learn.CreateAsync([recorded]); // waits for the code
Console.WriteLine(learned.Code); // async function main(params = { site: "..." }) { ... }

var inputs = new Dictionary<string, object> { ["site"] = "https://lobste.rs" };
await using var lease = await sai.Control.OpenAsync(pc);
var run = await lease.RunAsync(learned, inputs); // inputs over the defaults

var repaired = await sai.Learn.CreateAsync([], new LearnOptions
{
    InitialCode = learned.Code,
    Evaluations = [new Evaluation(inputs, run, Passed: false)],
});
var judgement = await sai.Judge.CreateAsync([recorded], new[] { new Check("title", "The agent reported a story title") });
```

With `MaxIterations`, `Learn.CreateAsync` also runs the code on a machine, judges each run, and
repairs the code after a failed run. It answers at once with a job; `WaitAsync` reads it until it ends.

```csharp
var job = await sai.Learn.CreateAsync([], new LearnOptions
{
    TaskTemplate = "Open {{site}} and read the title of the top story",
    Inputs = new Dictionary<string, object> { ["site"] = "https://news.ycombinator.com" },
    Machine = pc,
    Criteria = "The answer is the title of the top story on the page",
    MaxIterations = 3,
    Rollouts = 3,
    Reset = Reset.Code("await machine.browser.newtab(\"https://news.ycombinator.com\")"), // or Reset.Task("...")
    ContinueWithAgent = true,
});
var done = await sai.Learn.WaitAsync(job); // can take an hour; timeout: to stop waiting
Console.WriteLine($"{done.Status} {done.StopReason} {done.TestResult}");
var rollout = await sai.Learn.RolloutAsync(job, 1, 1);
await sai.Learn.CancelAsync(job);
```

## Run Sai for your customers

With an [Organisation](https://platform.simular.ai/documentation/organisations), each customer is a
Tenant. Your backend manages Tenants with an Organisation Key, and acts as one with a Tenant token.

```csharp
var org = new SaiClient(new SaiClientOptions { ApiKey = "sapi_...", OrgId = "org_..." }); // or SAI_API_KEY, SAI_ORG_ID

var tenant = await org.Tenants.CreateAsync("Riverside Clinic", externalId: "clinic-4821");
var code = await org.Tenants.CreateEnrollmentAsync(tenant); // hand code.Token to your installer

var clinic = await org.Tenants.ClientAsync(tenant); // acts as the Tenant; renews its token
var visit = await clinic.Sessions.CreateAsync();
await visit.RunAsync("Open the calendar and read today's appointments");

var machine = await org.TenantMachines.CreateAsync(tenant, os: "windows", requestId: Guid.NewGuid().ToString(), wait: true);
await org.Tenants.UpdateAsync(tenant, new TenantUpdate { CloudMachineLimit = null }); // null removes the cap
```

- `Tenants.ListAsync(status:, externalId:, limit:, cursor:)` returns one page: `page.Tenants`,
  `page.NextCursor`.
- `Tenants.UpdateAsync(tenant, new TenantUpdate { ... })` sends only what is set; setting
  `CloudMachineLimit` to null removes the cap.
- `TenantMachines.DeleteAsync(tenant, machine)` returns `"revoked"` for an enrolled machine and
  `"deleting"` for a cloud machine.
- `Usage.GetAsync(granularity:, from:, to:)` and `Usage.SessionsAsync(tenant, from:, to:, cursor:)`
  report what the Organisation and each Tenant's sessions spent.

To charge for a task as soon as it ends, look its session up in real time instead of a date range:

```csharp
var page = await org.Usage.SessionsAsync(tenant, sessionIds: [session.Id]);
foreach (var s in page.Sessions)
{
    if (s.Settled == true) Console.WriteLine($"{s.SessionId} {s.CostUsd} {page.AsOf}");
}
```

With `sessionIds` (1 to 50 of the Tenant's sessions) each session comes back with its spend so far and
`Settled`: `true` once its latest task has ended and every charge for it has come in. Ask again every
10 seconds or so until it is. `CostUsd` and `ModelCalls` are null when the session can't be read in
full right now. An id that is not one of the Tenant's sessions is left out. See
[Session spend](https://platform.simular.ai/documentation/organisations/session-spend) for the limits.

## Errors

Every non-2xx response throws a `SaiException` subclass with `Status`, `Code`, `Message`, `Body` and
`RetryAfter`: `AuthenticationException` (401), `BadRequestException` (400),
`PermissionDeniedException` (403), `NotFoundException` (404), `ConflictException` (409),
`LinkOnlyApprovalException` (`ApprovalUrl`), `GoneException` (410), `SpendCapReachedException` (403,
`ResetsAt`), `RateLimitException` (429), `ServiceUnavailableException` (503), `ConnectionException`,
`BlockException`. They are the surface's `*Error` classes, named the .NET way.

A task that ran out of credit ends with `result.Status == "error"` and `result.ErrorCode` set to
`insufficient_credits` or `free_computer_time_exhausted`: stop retrying for today.

## Configuration

| Option       | Env           | Default                           |
| ------------ | ------------- | --------------------------------- |
| `ApiKey`     | `SAI_API_KEY` | required                          |
| `BaseUrl`    | `SAI_API_URL` | `https://api.simular.ai`          |
| `Timeout`    |               | 60 seconds per request            |
| `VersionTag` |               | sent as `x-sai-version`           |
| `HttpClient` |               | one the client makes and disposes |
| `OrgId`      | `SAI_ORG_ID`  | for `Tenants.TokenAsync()`        |

## Development

```bash
cd dotnet
dotnet test    # parity with surface.json, the conformance cases, and the docs' C# snippets
dotnet pack -c Release
```

The tests start the mock server (`node ../conformance/server.mjs`), so Node must be on `PATH`. The docs
are read from `SAI_DOCS_DIR`, by default `../sai-platform/src/docs/content`; set `SAI_DOCS_REQUIRED=1`
to fail when they are missing.
