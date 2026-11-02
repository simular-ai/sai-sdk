using System.Text.Json;

namespace Simular.Sai;

// Response objects. Each keeps the server's JSON in `Raw`, so a field the SDK does not model yet is
// still reachable.

/// <summary>The SDK's event kinds. <see cref="Other"/> only appears with <c>EventsAsync(raw: true)</c>.</summary>
public static class EventKind
{
    public const string Step = "step";
    public const string Message = "message";
    public const string Approval = "approval";
    public const string ToolError = "tool_error";
    public const string Error = "error";
    public const string Finished = "finished";
    public const string Other = "other";

    public static IReadOnlyList<string> All { get; } = [Step, Message, Approval, ToolError, Error, Finished, Other];
}

/// <summary>Turn statuses: <c>running</c> while polling, then one of the three others.</summary>
public static class TurnStatus
{
    public const string Running = "running";
    public const string Idle = "idle";
    public const string NeedsApproval = "needs_approval";
    public const string Error = "error";

    public static IReadOnlyList<string> All { get; } = [Running, Idle, NeedsApproval, Error];
}

/// <summary>Turn record statuses, from <c>GET /v1/agents/turns/{id}</c>.</summary>
public static class TurnRecordStatus
{
    public const string Running = "running";
    public const string NeedsInput = "needs_input";
    public const string Finalizing = "finalizing";
    public const string Succeeded = "succeeded";
    public const string Failed = "failed";

    public static IReadOnlyList<string> All { get; } = [Running, NeedsInput, Finalizing, Succeeded, Failed];
}

/// <summary>Plan and spendable credit. <see cref="CreditsUsd"/> is null on the unlimited plan or when billing could not be reached.</summary>
public sealed record Account(
    string UserId, string? PlanId, string PlanTitle, bool Free, bool Unlimited, double? CreditsUsd, JsonElement Raw)
{
    internal static Account Parse(JsonElement d)
    {
        var plan = d.Obj("plan");
        return new(
            d.Str("userId") ?? "", plan.Str("id"), plan.Str("title") ?? "", plan.Truthy("free"),
            plan.Truthy("unlimited"), d.Obj("credits").Num("usd"), d);
    }
}

/// <summary>A model a session can run on; <see cref="Allowed"/> says whether this plan may use it.</summary>
public sealed record Model(string Id, string Name, string Provider, string Tier, string CostTier, bool Allowed, JsonElement Raw)
{
    internal static Model Parse(JsonElement d)
    {
        var id = d.Str("id") ?? "";
        return new(
            id, d.Str("name") ?? id, d.Str("provider") ?? "", d.Str("tier") ?? "", d.Str("costTier") ?? "",
            !d.Has("allowed") || d.Truthy("allowed"), d);
    }
}

/// <summary>
/// A computer Sai works on. <see cref="Kind"/> is <c>cloud</c> or <c>own</c>; <see cref="State"/> is
/// <c>running</c>, <c>starting</c>, <c>asleep</c>, <c>creating</c> or <c>unknown</c> (null on older
/// servers); <see cref="Os"/> is <c>windows</c>, <c>linux</c>, <c>macOS</c> or <c>android</c>.
/// </summary>
public sealed record Machine(
    string Id, string? Name, string Kind, bool Online, string? State,
    string? Status,
    bool CanWake, string? Os, JsonElement Raw)
{
    internal static Machine Parse(JsonElement d) => new(
        d.Str("machineId") ?? "", d.Str("name"), d.Str("kind") ?? "", d.Truthy("online"), d.Str("state"),
        d.Str("status"), d.Truthy("canWake"), d.Str("os"), d);
}

/// <summary>
/// A computer's live screen. Both URLs carry a token: keep them private. <see cref="LiveUrl"/> is a
/// page a person can open without a Simular sign-in, until <see cref="ExpiresAt"/> (Unix ms) or
/// <c>RevokeLiveAsync</c>; null where the server does not offer it.
/// </summary>
public sealed record LiveView(string MachineId, string? LiveUrl, long? ExpiresAt, string WebsocketUrl, int Width, int Height);

/// <summary>One of your customers under an Organisation.</summary>
public sealed record Tenant(
    string Id, string Name, string? ExternalId, IReadOnlyDictionary<string, string> Metadata, string Status,
    long CreatedAt, long? DisabledAt, long MachineCount, long? CloudMachineLimit, bool? ResidentialProxy,
    long? CloudMachineCount, JsonElement Raw)
{
    internal static Tenant Parse(JsonElement d) => new(
        d.Str("tenantId") ?? "", d.Str("name") ?? "", d.Str("externalId"),
        d.Obj("metadata").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.Str() ?? p.Value.GetRawText()),
        d.Str("status") ?? "", d.Long("createdAt") ?? 0, d.Long("disabledAt"), d.Long("machineCount") ?? 0,
        d.Long("cloudMachineLimit"), d.BoolOrNull("residentialProxy"), d.Long("cloudMachineCount"), d);
}

/// <summary>One page of Tenants. Pass <see cref="NextCursor"/> as <c>cursor</c> for the next; null on the last page.</summary>
public sealed record TenantPage(IReadOnlyList<Tenant> Tenants, string? NextCursor);

/// <summary>
/// A Tenant's computer: enrolled, or a cloud machine Sai hosts for it. <see cref="State"/> is
/// <c>online</c> or <c>offline</c> (enrolled), or <c>provisioning</c>, <c>ready</c>, <c>starting</c>,
/// <c>hibernated</c>, <c>deleting</c> or <c>failed</c> (cloud).
/// </summary>
public sealed record TenantMachine(
    string Id, string? Name, string? Platform, string Status, bool Online, long? LastSeen, string? RuntimeVersion,
    string Kind, string State, string? MachineClass, long? CreatedAt, JsonElement Raw)
{
    internal static TenantMachine Parse(JsonElement d)
    {
        // Servers before cloud machines send `online` and `status` and no `kind` or `state`.
        var s = d.Str("state");
        var state = string.IsNullOrEmpty(s) ? (d.Truthy("online") ? "online" : "offline") : s;
        return new(
            d.Str("machineId") ?? "", d.Str("name"), d.Str("platform"), d.Str("status") ?? "",
            d.Has("online") ? d.Truthy("online") : state is "online" or "ready", d.Long("lastSeen"),
            d.Str("runtimeVersion"), d.Str("kind") == "cloud" ? "cloud" : "enrolled", state, d.Str("machineClass"),
            d.Long("createdAt"), d);
    }
}

/// <summary>A single-use code that enrolls one computer; <see cref="ExpiresAt"/> is Unix ms.</summary>
public sealed record Enrollment(string Token, long ExpiresAt, JsonElement Raw)
{
    internal static Enrollment Parse(JsonElement d) => new(d.Str("enrollmentToken") ?? "", d.Long("expiresAt") ?? 0, d);
}

/// <summary>A one-hour token that acts as a Tenant: pass it as <c>ApiKey</c>. <see cref="ExpiresAt"/> is Unix ms.</summary>
public sealed record TenantToken(string Token, long ExpiresAt, string TenantId, JsonElement Raw)
{
    internal static TenantToken Parse(JsonElement d) =>
        new(d.Str("token") ?? "", d.Long("expiresAt") ?? 0, d.Str("tenantId") ?? "", d);
}

/// <summary>A file uploaded with <c>Files.UploadAsync</c>. Pass it in <c>Attachments</c>.</summary>
public sealed record Attachment(string FileId, string Name, string Mime, long Size, JsonElement Raw)
{
    internal static Attachment Parse(JsonElement d) =>
        new(d.Str("fileId") ?? "", d.Str("name") ?? "", d.Str("mime") ?? "", d.Long("size") ?? 0, d);
}

/// <summary>
/// Sai is waiting for permission, or for an answer to a choice question. A <c>choice</c>
/// <see cref="Type"/> needs selections. <see cref="IsLinkOnly"/>: a human must answer at <see cref="Url"/>.
/// </summary>
public sealed record Approval(
    string Id, string Title, string Description, string Type, bool IsLinkOnly, string? Url, string? Command,
    IReadOnlyList<JsonElement> Questions, JsonElement Raw)
{
    internal static Approval Parse(JsonElement d) => new(
        d.Str("approvalId") ?? "", d.Str("title") ?? "", d.Str("description") ?? "", d.Str("approvalType") ?? "",
        d.Truthy("isLinkOnly"), d.Str("approvalUrl"), d.Str("command"), d.Arr("questions").ToList(), d);
}

/// <summary>Tokens and cost of model calls.</summary>
public sealed record Usage(
    long InputTokens, long OutputTokens, long CacheReadTokens, long CacheWriteTokens, double CostUsd,
    long ModelCalls, JsonElement ByModel)
{
    internal static Usage? Parse(JsonElement u) => u.IsObject()
        ? new(
            u.Long("inputTokens") ?? 0, u.Long("outputTokens") ?? 0, u.Long("cacheReadTokens") ?? 0,
            u.Long("cacheWriteTokens") ?? 0, u.Num("costUsd") ?? 0, u.Long("modelCalls") ?? 0, u.Obj("byModel"))
        : null;
}

/// <summary>
/// One thing that happened in a turn. <see cref="Kind"/> is one of <see cref="EventKind"/>;
/// <see cref="Type"/> is the wire type. <see cref="Code"/> is set on errors such as
/// <c>insufficient_credits</c>.
/// </summary>
public sealed record Event(string Kind, string Type, string? Text, Approval? Approval, string? Code, JsonElement Raw)
{
    // Wire event type → SDK kind. Anything not listed is framing or internal detail.
    private static readonly Dictionary<string, string> Kinds = new()
    {
        ["data-progress"] = EventKind.Step,
        ["text-delta"] = EventKind.Message,
        ["data-approval-request"] = EventKind.Approval,
        ["tool-output-error"] = EventKind.ToolError,
        ["error"] = EventKind.Error,
        ["finish"] = EventKind.Finished,
    };

    internal static Event Parse(JsonElement d)
    {
        var t = d.Str("type") ?? "";
        var data = d.Obj("data");
        string? text = null;
        Approval? approval = null;
        if (t == "data-progress") text = data.Str("text");
        else if (t is "text-delta" or "reasoning-delta") text = d.Str("delta");
        else if (t is "tool-output-error" or "error") text = d.Str("errorText");
        else if (t == "data-approval-request" && data.Truthy("approvalId"))
        {
            approval = Approval.Parse(data);
            text = approval.Title;
        }
        return new(Kinds.GetValueOrDefault(t, EventKind.Other), t, text, approval, d.Str("code"), d);
    }
}

/// <summary>
/// Where a turn stopped. <see cref="Status"/> is <c>idle</c> (done: <see cref="Text"/> is the
/// answer), <c>error</c>, or <c>needs_approval</c> (waiting on <see cref="Approval"/>). <see cref="Record"/>
/// is the turn's record for a structured message.
/// </summary>
public sealed record TurnResult(
    string Status, string Text, string SessionId, Approval? Approval, string? Error, string? ErrorCode,
    Usage? Usage, Usage? SessionUsage, TurnRecord? Record)
{
    /// <summary>Idle, and for a structured message, the turn succeeded.</summary>
    public bool Ok => Status == TurnStatus.Idle && (Record?.Ok ?? true);
}

/// <summary>One yes/no constraint a turn is checked against. <see cref="Id"/>: letters, digits, <c>_</c> or <c>-</c>.</summary>
public sealed record Check(string Id, string Text, bool ReturnEvidence = false);

/// <summary>A guideline for a judge (a string), or yes/no <see cref="Check"/>s.</summary>
public sealed class Criteria
{
    private Criteria(string? text, IReadOnlyList<Check>? checks)
    {
        Text = text;
        Checks = checks;
    }

    public string? Text { get; }

    public IReadOnlyList<Check>? Checks { get; }

    public static implicit operator Criteria(string text) => new(text, null);

    public static implicit operator Criteria(Check[] checks) => new(null, checks);

    public static implicit operator Criteria(List<Check> checks) => new(null, checks);

    internal System.Text.Json.Nodes.JsonNode ToJson()
    {
        if (Checks is null) return System.Text.Json.Nodes.JsonValue.Create(Text)!;
        var a = new System.Text.Json.Nodes.JsonArray();
        foreach (var c in Checks)
        {
            var o = new System.Text.Json.Nodes.JsonObject { ["id"] = c.Id, ["check"] = c.Text };
            if (c.ReturnEvidence) o["returnEvidence"] = true;
            a.Add(o);
        }
        return a;
    }
}

/// <summary>The verdict on one success criterion. <see cref="Id"/> is null for a natural-language criteria.</summary>
public sealed record CriterionEvidence(string? Id, bool Passed, double? Score, string? Evidence);

/// <summary>
/// A turn's record. <see cref="Status"/> is one of <see cref="TurnRecordStatus"/>; on <c>failed</c>,
/// <see cref="ReasonCode"/> says why. <see cref="Output"/> is the agent's final text, or an object
/// matching the output schema.
/// </summary>
public sealed record TurnRecord(
    string Id, string? SessionId, string MachineId, string Status, JsonElement? Output, string? ReasonCode,
    string? RawAnswer, string? ErrorCode, IReadOnlyList<string> OutputErrors, IReadOnlyList<CriterionEvidence> Evidence,
    Usage? Usage, bool RecordTrajectory, bool TrajectoryRecorded, string? Template, JsonElement? Inputs, bool Replayed,
    JsonElement Raw)
{
    public bool Done => Status is TurnRecordStatus.Succeeded or TurnRecordStatus.Failed;

    public bool Ok => Status == TurnRecordStatus.Succeeded;

    internal static TurnRecord Parse(JsonElement d)
    {
        var inputs = d.Get("inputs");
        return new(
            d.Str("turnId") ?? "", d.Str("sessionId"), d.Str("machineId") ?? "", d.Str("status") ?? TurnRecordStatus.Running,
            d.Opaque("output"), d.Str("reason_code"), d.Str("raw_answer"), d.Str("error_code"), d.Strings("output_errors"),
            d.Arr("evidence").Select(e => new CriterionEvidence(e.Str("id"), e.Truthy("passed"), e.Num("score"), e.Str("evidence"))).ToList(),
            Usage.Parse(d.Get("usage")), d.Truthy("recordTrajectory"), d.Obj("trajectory").Truthy("recorded"), d.Str("template"),
            inputs.ValueKind is JsonValueKind.Object or JsonValueKind.Array ? inputs : null, d.Truthy("idempotent_replay"), d);
    }
}

/// <summary>One step the agent took. Fetch its screen with <c>Turns.ScreenshotAsync</c>.</summary>
public sealed record TrajectoryStep(
    int Index, bool Final, string Timestamp, string? Title, string? Code, string? Rationale, string? Error,
    bool HasScreenshot, JsonElement Raw)
{
    internal static TrajectoryStep Parse(JsonElement d) => new(
        d.Int("index") ?? 0, d.Truthy("final"), d.Str("timestamp") ?? "", d.Str("title"), d.Str("code"),
        d.Str("rationale"), d.Str("error"), d.Truthy("screenshot"), d);
}

/// <summary>Why a block failed: <see cref="Kind"/> is <c>exception</c>, <c>timeout</c> or <c>interrupted</c>.</summary>
public sealed record ExecError(string Kind, string Message, string? Stack);

/// <summary>What one Simulang block returned. A block that threw is still a result: check <see cref="Error"/>.</summary>
public sealed record ExecResult(
    JsonElement? Result, IReadOnlyList<string> Logs, ExecError? Error, byte[]? Screenshot, string? ScreenshotMimeType,
    bool ScreenshotOmitted, IReadOnlyList<JsonElement> Variables, double DurationMs, JsonElement Raw)
{
    public bool Ok => Error is null;

    internal static ExecResult Parse(JsonElement d)
    {
        var obs = d.Obj("observations");
        var shot = obs.Obj("screenshot");
        var b64 = shot.Str("base64");
        var err = d.Get("error");
        var error = err.Truthy() ? new ExecError(err.Str("kind") ?? "", err.Str("message") ?? "", err.Str("stack")) : null;
        return new(
            d.Opaque("result"), d.Strings("logs"), error, string.IsNullOrEmpty(b64) ? null : Convert.FromBase64String(b64),
            shot.Str("mimeType"), obs.Truthy("screenshotOmitted"), d.Arr("variables").ToList(), d.Num("durationMs") ?? 0, d);
    }
}

/// <summary>What <c>ControlLease.ShellAsync</c> returns.</summary>
public sealed record ShellResult(string Stdout, string Stderr, int ExitCode, bool TimedOut);

/// <summary>One input of learned code: a <c>{{name}}</c> in the template and a key of <c>main</c>'s params.</summary>
public sealed record LearnParameter(string Name, string DefaultValue, string? Description);

/// <summary>How learned code did on one run, for a repair. Its result's screenshot is not sent.</summary>
public sealed record Evaluation(
    IReadOnlyDictionary<string, object> Inputs, ExecResult? Result = null, JudgementRef? Judgement = null,
    bool? Passed = null, string? Note = null);

/// <summary>What a <c>Reset</c> did before a run. <see cref="Kind"/> is <c>code</c> or <c>task</c>.</summary>
public sealed record LearnReset(string Kind, bool Ok, double? DurationMs, string? TurnId, string? Error)
{
    internal static LearnReset? Parse(JsonElement r) => r.IsObject()
        ? new(r.Str("kind") == "task" ? "task" : "code", r.Truthy("ok"), r.Num("durationMs"), r.Str("turnId"), r.Str("error"))
        : null;
}

/// <summary>One run of a version of the code in a learn job. <see cref="Verdict"/> is null while it runs.</summary>
public sealed record LearnRollout(
    int Index, string? Verdict, LearnReset? Reset, string? Error, JsonElement? Result, double? DurationMs,
    string? JudgementId, string? Summary, string? ContinuationTurnId, bool ContinuationTimedOut);

/// <summary>One version of the code in a learn job, and its runs. <see cref="Index"/> is 1-based.</summary>
public sealed record LearnIteration(
    int Index, string? LearnId, string? Changes, int Passed, int Runs, IReadOnlyList<LearnRollout> Rollouts)
{
    internal static LearnIteration Parse(JsonElement d) => new(
        d.Int("index") ?? 0, d.Str("learnId"), d.Str("changes"), d.Int("passed") ?? 0, d.Int("runs") ?? 0,
        d.Arr("rollouts").Select(r => new LearnRollout(
            r.Int("index") ?? 0, r.Str("verdict"), LearnReset.Parse(r.Get("reset")), r.Str("error"), r.Opaque("result"),
            r.Num("durationMs"), r.Str("judgementId"), r.Str("summary"), r.Str("continuationTurnId"),
            r.Truthy("continuationTimedOut"))).ToList());
}

/// <summary>How the returned code did when it was run: <see cref="Status"/> is <c>not_judged</c>, <c>passed</c> or <c>failed</c>.</summary>
public sealed record LearnTestResult(string Status, int PassedRuns, int RequiredRuns, JsonElement? Inputs);

/// <summary>While a job runs: the step it is on.</summary>
public sealed record LearnProgress(string Step, int? Iteration, int? Rollout);

/// <summary>With <c>JudgeInitialAgentRun</c>: the judgement of the agent run.</summary>
public sealed record AgentJudgement(string JudgementId, string Verdict, string? Summary);

public sealed record LearnValidation(IReadOnlyList<string> Errors, IReadOnlyList<string> Warnings);

/// <summary>
/// The result of <c>Learn.CreateAsync</c>: Simulang code, a repair, or a learn job.
/// <see cref="Mode"/> is <c>convert</c>, <c>heal</c> or <c>policyIteration</c>; <see cref="Status"/> is
/// <c>succeeded</c>, <c>failed</c>, <c>running</c> or <c>stopped</c>. Run the code with
/// <c>lease.RunAsync(learned, inputs)</c>. Research preview.
/// </summary>
public sealed record LearnResult(
    string Id, string Mode, string Status, string? StopReason, string? Message, LearnTestResult? TestResult,
    LearnProgress? Progress, string? AgentTurnId, LearnReset? AgentRunReset, AgentJudgement? AgentJudgement,
    int? Version, IReadOnlyList<LearnIteration> Iterations, string? Title, string? Template,
    IReadOnlyList<LearnParameter> Parameters, string Code, JsonElement? OutputSchema, LearnValidation Validation,
    string? Changes, IReadOnlyList<string> SourceTurns, Usage? Usage, string? Error, bool Replayed, JsonElement Raw)
{
    public bool Ok => Status == "succeeded";

    internal static LearnResult Parse(JsonElement d)
    {
        var mode = d.Str("mode");
        var t = d.Get("testResult");
        var p = d.Get("progress");
        var aj = d.Get("agentJudgement");
        var v = d.Obj("validation");
        var schema = d.Get("outputSchema");
        return new(
            d.Str("learnId") ?? "", mode is "heal" or "policyIteration" ? mode : "convert", d.Str("status") ?? "running",
            d.Str("stopReason"), d.Str("message"),
            t.Truthy() ? new LearnTestResult(t.Str("status") ?? "not_judged", t.Int("passedRuns") ?? 0, t.Int("requiredRuns") ?? 0,
                t.Get("inputs").Truthy() ? t.Obj("inputs") : null) : null,
            p.Truthy() ? new LearnProgress(p.Str("step") ?? "", p.Int("iteration"), p.Int("rollout")) : null,
            d.Str("agentTurnId"), LearnReset.Parse(d.Get("agentRunReset")),
            aj.Truthy() ? new AgentJudgement(aj.Str("judgementId") ?? "", aj.Str("verdict") ?? "", aj.Str("summary")) : null,
            d.Int("version"), d.Arr("iterations").Select(LearnIteration.Parse).ToList(), d.Str("title"), d.Str("template"),
            d.Arr("parameters").Select(x => new LearnParameter(x.Str("name") ?? "", x.Str("defaultValue") ?? "", x.Str("description"))).ToList(),
            d.Str("code") ?? "", schema.Truthy() ? d.Obj("outputSchema") : null,
            new LearnValidation(v.Strings("errors"), v.Strings("warnings")), d.Str("changes"), d.Strings("sourceTurns"),
            Usage.Parse(d.Get("usage")), d.Str("error"), d.Truthy("idempotent_replay"), d);
    }
}

/// <summary>One run of a learn job's code: <see cref="Run"/> is what it returned and logged.</summary>
public sealed record LearnRun(string LearnId, int Iteration, int Rollout, JsonElement Run, JsonElement? Judgement, JsonElement Raw)
{
    internal static LearnRun Parse(JsonElement d) => new(
        d.Str("learnId") ?? "", d.Int("iteration") ?? 0, d.Int("rollout") ?? 0, d.Obj("run"),
        d.Get("judgement").Truthy() ? d.Obj("judgement") : null, d);
}

/// <summary>The verdict on one criterion: <see cref="Verdict"/> is <c>passed</c>, <c>failed</c> or <c>unverifiable</c>.</summary>
public sealed record CriterionResult(string? Id, string Check, string Verdict, double? Score, string? Evidence);

/// <summary>The result of <c>Judge.CreateAsync</c>. It never changes the turns it judged. Research preview.</summary>
public sealed record Judgement(
    string Id, string? Verdict, string? Summary, string? Task, IReadOnlyList<CriterionResult> Criteria,
    IReadOnlyList<string> Turns, Usage? Usage, bool Replayed, JsonElement Raw)
{
    public bool Ok => Verdict == "passed";

    internal static Judgement Parse(JsonElement d) => new(
        d.Str("judgementId") ?? "", d.Str("verdict"), d.Str("summary"), d.Str("task"),
        d.Arr("criteria").Select(c => new CriterionResult(
            c.Str("id"), c.Str("check") ?? "", c.Str("verdict") ?? "unverifiable", c.Num("score"), c.Str("evidence"))).ToList(),
        d.Strings("turns"), Usage.Parse(d.Get("usage")), d.Truthy("idempotent_replay"), d);
}

/// <summary>Who the key or token acts as. <see cref="AuthType"/> is <c>apiKey</c> or <c>firebase</c>.</summary>
public sealed record AuthInfo(string UserId, string AuthType, string? TenantId, string? OrgId, JsonElement Raw)
{
    internal static AuthInfo Parse(JsonElement d) =>
        new(d.Str("userId") ?? "", d.Str("authType") ?? "", d.Str("tenantId"), d.Str("orgId"), d);
}

/// <summary>A session on a computer. <see cref="Active"/>: the session the next message goes to.</summary>
public sealed record SessionSummary(string Id, string Title, long UpdatedAt, bool Active, JsonElement Raw)
{
    internal static SessionSummary Parse(JsonElement d) =>
        new(d.Str("sessionId") ?? "", d.Str("title") ?? "", d.Long("updatedAt") ?? 0, d.Truthy("active"), d);
}

public sealed record CategoryUsage(double CostCents);

/// <summary>One Tenant's spend in an Organisation usage report, by kind (<c>token</c>, <c>compute</c>).</summary>
public sealed record TenantUsage(
    string TenantId, string? Name, string? ExternalId, double CostCents, IReadOnlyDictionary<string, CategoryUsage> ByCategory);

/// <summary>One period of an Organisation usage report, or the whole range. <see cref="ByTenant"/> is keyed by Tenant id.</summary>
public sealed record UsageBucket(string? Bucket, double CostCents, IReadOnlyDictionary<string, TenantUsage> ByTenant)
{
    internal static UsageBucket Parse(JsonElement d) => new(
        d.Str("bucket"), d.Num("costCents") ?? 0,
        d.Obj("byTenant").EnumerateObject().ToDictionary(p => p.Name, p =>
        {
            var t = p.Value.IsObject() ? p.Value : J.EmptyObject;
            return new TenantUsage(
                t.Str("tenantId") ?? p.Name, t.Str("name"), t.Str("externalId"), t.Num("costCents") ?? 0,
                t.Obj("byCategory").EnumerateObject().ToDictionary(
                    c => c.Name, c => new CategoryUsage((c.Value.IsObject() ? c.Value : J.EmptyObject).Num("costCents") ?? 0)));
        }));
}

/// <summary>What an Organisation is charged, per Tenant.</summary>
public sealed record OrgUsage(string Granularity, string From, string To, UsageBucket Totals, IReadOnlyList<UsageBucket> Buckets, JsonElement Raw)
{
    internal static OrgUsage Parse(JsonElement d) => new(
        d.Str("granularity") ?? "", d.Str("from") ?? "", d.Str("to") ?? "", UsageBucket.Parse(d.Obj("totals")),
        d.Arr("buckets").Select(b => UsageBucket.Parse(b.IsObject() ? b : J.EmptyObject)).ToList(), d);
}

/// <summary>What one of a Tenant's sessions spent on AI calls, in US dollars; days are UTC <c>YYYY-MM-DD</c>.</summary>
public sealed record SessionSpend(string SessionId, string? Title, double CostUsd, long ModelCalls, string FirstDay, string LastDay);

/// <summary>One page of session spend. A page can be empty and still have a <see cref="NextCursor"/>.</summary>
public sealed record SessionSpendPage(IReadOnlyList<SessionSpend> Sessions, string? NextCursor, string? DataThrough, JsonElement Raw)
{
    internal static SessionSpendPage Parse(JsonElement d) => new(
        d.Arr("sessions").Select(s => s.IsObject() ? s : J.EmptyObject).Select(s => new SessionSpend(
            s.Str("sessionId") ?? "", string.IsNullOrEmpty(s.Str("title")) ? null : s.Str("title"), s.Num("costUsd") ?? 0,
            s.Long("modelCalls") ?? 0, s.Str("firstDay") ?? "", s.Str("lastDay") ?? "")).ToList(),
        d.Str("nextCursor"), d.Str("dataThrough"), d);
}
