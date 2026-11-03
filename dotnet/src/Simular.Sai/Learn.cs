using System.Text.Json.Nodes;

namespace Simular.Sai;

/// <summary>Run before the agent run and before every run of the code: Simulang code, or a task for the agent.</summary>
public sealed class Reset
{
    private Reset(string key, string value)
    {
        Key = key;
        Value = value;
    }

    internal string Key { get; }

    internal string Value { get; }

    public static Reset Code(string code) => new("code", code);

    public static Reset Task(string task) => new("task", task);
}

/// <summary>Options for <see cref="Learn.CreateAsync"/>.</summary>
public sealed class LearnOptions
{
    /// <summary>
    /// The task, with <c>{{name}}</c> placeholders. Without turns, the agent does this task first.
    /// With turns, it defaults to the first turn's.
    /// </summary>
    public string? TaskTemplate { get; init; }

    /// <summary>A value for every placeholder; with turns, defaults to the first turn's.</summary>
    public IReadOnlyDictionary<string, object>? Inputs { get; init; }

    /// <summary>Code to repair (with <c>MaxIterations</c> 0), or to start the run-judge-repair loop from.</summary>
    public string? InitialCode { get; init; }

    /// <summary>How <c>InitialCode</c> did on runs (a repair only).</summary>
    public IReadOnlyList<Evaluation>? Evaluations { get; init; }

    /// <summary>What you know about the task, for writing and repairing the code.</summary>
    public string? Guidance { get; init; }

    /// <summary>For a repair: what earlier versions changed and how they failed.</summary>
    public string? History { get; init; }

    /// <summary>The code will be run again and again with no reset in between, so it opens the app or URL itself.</summary>
    public bool? RunsWithoutReset { get; init; }

    /// <summary>Code versions to run, judge and repair: 0 (the default) only writes the code. At most 5.</summary>
    public int? MaxIterations { get; init; }

    /// <summary>Runs per code version; a version passes when all of them pass. Default 3, at most 5.</summary>
    public int? Rollouts { get; init; }

    /// <summary>The machine to run on; optional with one machine.</summary>
    public MachineRef? Machine { get; init; }

    /// <summary>What "done" means for the judge; default: the task as written, with its inputs.</summary>
    public Criteria? Criteria { get; init; }

    public Reset? Reset { get; init; }

    /// <summary>Judge the agent run first; if it fails, the job stops with the judgement and writes no code.</summary>
    public bool? JudgeInitialAgentRun { get; init; }

    /// <summary>After a failed run, let the agent finish the task; its turn feeds the repair.</summary>
    public bool? ContinueWithAgent { get; init; }

    public int? RolloutMinutes { get; init; }

    public int? AgentRunMinutes { get; init; }

    public int? ContinuationMinutes { get; init; }

    /// <summary>Limit of the whole job, in minutes. Default 615, at most 690.</summary>
    public int? MaxJobMinutes { get; init; }

    /// <summary>A model id from <c>Models.ListAsync</c>; without it, Sai picks the model.</summary>
    public string? Model { get; init; }

    /// <summary>The same key again returns the earlier result and runs nothing.</summary>
    public string? IdempotencyKey { get; init; }

    /// <summary>Request timeout. Default 10 minutes.</summary>
    public TimeSpan? Timeout { get; init; }
}

/// <summary>Options for <see cref="Judge.CreateAsync"/>.</summary>
public sealed class JudgeOptions
{
    /// <summary>Default: the first turn's message.</summary>
    public string? Task { get; init; }

    public string? IdempotencyKey { get; init; }

    /// <summary>Request timeout. Default 3 minutes.</summary>
    public TimeSpan? Timeout { get; init; }
}

/// <summary>
/// Turn recorded turns, or a task the agent does first, into Simulang code you own; repair it; run,
/// judge and repair it on a machine until it passes. Research preview.
/// </summary>
public sealed class Learn
{
    /// <summary>A conversion is two model calls of up to a minute or two each, plus one retry.</summary>
    private static readonly TimeSpan DefaultTimeout = TimeSpan.FromMinutes(10);
    /// <summary>How often <see cref="WaitAsync"/> reads a learn job.</summary>
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(10);
    /// <summary>The last log lines of a run sent with an evaluation; the API takes 20 KB per result.</summary>
    private const int EvalLogLines = 30;

    private readonly Http _http;

    internal Learn(Http http) => _http = http;

    /// <summary>
    /// Make Simulang code, and optionally run, judge and repair it on a machine: code from recorded
    /// turns, a repair (<c>InitialCode</c> with <c>Guidance</c> or <c>Evaluations</c>), or with
    /// <c>MaxIterations</c> a job that answers at once with <c>Status == "running"</c> (read it with
    /// <see cref="WaitAsync"/>). A result with validation errors comes back <c>failed</c>.
    /// </summary>
    public async Task<LearnResult> CreateAsync(
        IReadOnlyList<TurnRef> turns, LearnOptions? options = null, CancellationToken cancellationToken = default)
    {
        var o = options ?? new LearnOptions();
        var body = new JsonObject { ["turns"] = new JsonArray(turns.Select(t => (JsonNode?)t.RequireId()).ToArray()) };
        if (o.TaskTemplate is not null) body["taskTemplate"] = o.TaskTemplate;
        if (o.Inputs is not null) body["inputs"] = J.ToNode(o.Inputs);
        if (o.InitialCode is not null) body["initialCode"] = o.InitialCode;
        if (o.Evaluations is not null) body["evaluations"] = new JsonArray(o.Evaluations.Select(EvaluationJson).ToArray());
        if (o.Guidance is not null) body["guidance"] = o.Guidance;
        if (o.Machine is not null) body["machineId"] = o.Machine.Id;
        if (o.History is not null) body["history"] = o.History;
        if (o.RunsWithoutReset is { } rwr) body["runsWithoutReset"] = rwr;
        if (o.MaxIterations is { } mi) body["maxIterations"] = mi;
        if (o.Rollouts is { } ro) body["rollouts"] = ro;
        if (o.Criteria is not null) body["criteria"] = o.Criteria.ToJson();
        if (o.Reset is not null) body["reset"] = new JsonObject { [o.Reset.Key] = o.Reset.Value };
        if (o.JudgeInitialAgentRun is { } j) body["judgeInitialAgentRun"] = j;
        if (o.ContinueWithAgent is { } c) body["continueWithAgent"] = c;
        if (o.RolloutMinutes is { } rm) body["rolloutMinutes"] = rm;
        if (o.AgentRunMinutes is { } am) body["agentRunMinutes"] = am;
        if (o.ContinuationMinutes is { } cm) body["continuationMinutes"] = cm;
        if (o.MaxJobMinutes is { } mj) body["maxJobMinutes"] = mj;
        if (o.Model is not null) body["model"] = o.Model;
        if (o.IdempotencyKey is not null) body["idempotency_key"] = o.IdempotencyKey;
        return LearnResult.Parse(await _http.JsonAsync(HttpMethod.Post, "/v1/agents/learn",
            new RequestOptions { Json = body, Timeout = o.Timeout ?? DefaultTimeout }, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>A learn call's result, or a job's progress so far.</summary>
    public async Task<LearnResult> GetAsync(string learnId, CancellationToken cancellationToken = default) =>
        LearnResult.Parse(await _http.JsonAsync(HttpMethod.Get, $"/v1/agents/learn/{Http.Q(learnId)}", null, cancellationToken)
            .ConfigureAwait(false));

    /// <summary>
    /// Read a learn job until it ends (<c>succeeded</c>, <c>failed</c> or <c>stopped</c>), every
    /// <paramref name="pollInterval"/> (default 10 s). <paramref name="timeout"/> throws
    /// <see cref="TimeoutException"/> with the job still running; it keeps running.
    /// </summary>
    public async Task<LearnResult> WaitAsync(
        LearnRef job, TimeSpan? timeout = null, TimeSpan? pollInterval = null, CancellationToken cancellationToken = default)
    {
        var poll = pollInterval ?? PollInterval;
        DateTimeOffset? deadline = timeout is { } t ? DateTimeOffset.UtcNow + t : null;
        while (true)
        {
            LearnResult r;
            try
            {
                r = await GetAsync(job.Id, cancellationToken).ConfigureAwait(false);
            }
            catch (RateLimitException e)
            {
                await Task.Delay(TimeSpan.FromSeconds(e.RetryAfter ?? 30), cancellationToken).ConfigureAwait(false);
                continue;
            }
            if (r.Status != "running") return r;
            if (deadline is { } dl && DateTimeOffset.UtcNow + poll > dl)
                throw new TimeoutException($"Learn job {job.Id} is still running.");
            await Task.Delay(poll, cancellationToken).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Stop a learn job at once, whatever step it is on. It keeps the last complete results and reads
    /// <c>stopped</c> / <c>cancelled</c> once it has ended, normally within seconds.
    /// </summary>
    public async Task CancelAsync(LearnRef job, CancellationToken cancellationToken = default) =>
        await _http.JsonAsync(HttpMethod.Post, $"/v1/agents/learn/{Http.Q(job.Id)}/cancel", null, cancellationToken).ConfigureAwait(false);

    /// <summary>One run of a learn job's code: what it returned and logged, and its judgement.</summary>
    public async Task<LearnRun> RolloutAsync(LearnRef job, int iteration, int rollout, CancellationToken cancellationToken = default) =>
        LearnRun.Parse(await _http.JsonAsync(HttpMethod.Get,
            $"/v1/agents/learn/{Http.Q(job.Id)}/iterations/{iteration}/rollouts/{rollout}", null, cancellationToken).ConfigureAwait(false));

    private static JsonNode EvaluationJson(Evaluation e)
    {
        var o = new JsonObject { ["inputs"] = J.ToNode(e.Inputs) };
        if (e.Result is { } r)
        {
            var result = new JsonObject
            {
                ["result"] = r.Result is { } v ? J.ToNode(v) : null,
                ["logs"] = new JsonArray(r.Logs.Skip(Math.Max(0, r.Logs.Count - EvalLogLines)).Select(l => (JsonNode?)l).ToArray()),
            };
            if (r.Error is { } err) result["error"] = new JsonObject { ["kind"] = err.Kind, ["message"] = err.Message };
            o["result"] = result;
        }
        if (e.Judgement is not null) o["judgement"] = e.Judgement.Id;
        if (e.Passed is { } p) o["passed"] = p;
        if (e.Note is not null) o["note"] = e.Note;
        return o;
    }
}

/// <summary>Judge recorded turns against criteria you choose now. Research preview.</summary>
public sealed class Judge
{
    private static readonly TimeSpan DefaultTimeout = TimeSpan.FromMinutes(3);

    private readonly Http _http;

    internal Judge(Http http) => _http = http;

    /// <summary>
    /// Judge recorded <paramref name="turns"/> (one session, as one task) against
    /// <paramref name="criteria"/>: a sentence for a model to judge, or a list of <see cref="Check"/>s.
    /// Nothing runs again, and the turns do not change.
    /// </summary>
    public async Task<Judgement> CreateAsync(
        IReadOnlyList<TurnRef> turns, Criteria criteria, JudgeOptions? options = null, CancellationToken cancellationToken = default)
    {
        var o = options ?? new JudgeOptions();
        var body = new JsonObject
        {
            ["turns"] = new JsonArray(turns.Select(t => (JsonNode?)t.RequireId()).ToArray()),
            ["criteria"] = criteria.ToJson(),
        };
        if (o.Task is not null) body["task"] = o.Task;
        if (o.IdempotencyKey is not null) body["idempotency_key"] = o.IdempotencyKey;
        return Judgement.Parse(await _http.JsonAsync(HttpMethod.Post, "/v1/agents/judge",
            new RequestOptions { Json = body, Timeout = o.Timeout ?? DefaultTimeout }, cancellationToken).ConfigureAwait(false));
    }

    public async Task<Judgement> GetAsync(string judgementId, CancellationToken cancellationToken = default) =>
        Judgement.Parse(await _http.JsonAsync(HttpMethod.Get, $"/v1/agents/judge/{Http.Q(judgementId)}", null, cancellationToken)
            .ConfigureAwait(false));
}
