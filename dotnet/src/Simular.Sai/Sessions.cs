using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Simular.Sai;

/// <summary>
/// What an approval handler answers: a response (<c>yes</c>, <c>no</c>, <c>task</c>), or a response
/// with selections for a choice. A handler returns null to leave the approval pending (a human
/// answers it in a browser).
/// </summary>
public sealed record ApprovalAnswer(string Response, IReadOnlyList<IReadOnlyList<string>>? Selections = null)
{
    public static implicit operator ApprovalAnswer(string response) => new(response);
}

/// <summary>Options for <see cref="Session.SendAsync"/>. Any of <c>Inputs</c>, <c>OutputSchema</c> or <c>SuccessCriteria</c> makes the message structured.</summary>
public class SendOptions
{
    /// <summary>An id from <c>Models.ListAsync</c> (or <c>auto</c>); sticks to the session until changed.</summary>
    public string? Model { get; init; }

    public IReadOnlyList<Attachment>? Attachments { get; init; }

    /// <summary>Values for the <c>{{name}}</c> placeholders in the message.</summary>
    public IReadOnlyDictionary<string, object>? Inputs { get; init; }

    /// <summary>JSON Schema (at most 32 KB) the turn's output must match: a JsonNode, or any object System.Text.Json serializes.</summary>
    public object? OutputSchema { get; init; }

    /// <summary>A guideline for a judge, or yes/no checks, the turn is checked against.</summary>
    public Criteria? SuccessCriteria { get; init; }

    /// <summary>The same key again returns the earlier turn and sends nothing.</summary>
    public string? IdempotencyKey { get; init; }

    /// <summary>Keep a screenshot and the action for each step (<c>Turns.TrajectoryAsync</c>).</summary>
    public bool RecordTrajectory { get; init; }

    /// <summary><c>off</c>, <c>low</c>, <c>medium</c>, <c>high</c> or <c>xhigh</c>, in place of the account's agent setting.</summary>
    public string? ThinkingLevel { get; init; }

    /// <summary>Run the turn without approval cards, as if "Trust for this task" had been answered.</summary>
    public bool Autonomous { get; init; }
}

/// <summary>Options for <see cref="Turn.WaitAsync"/>.</summary>
public class WaitOptions
{
    /// <summary>Answers each approval: a response, a response with selections, or null to leave it pending.</summary>
    public Func<Approval, ApprovalAnswer?>? OnApproval { get; init; }

    /// <summary>As <see cref="OnApproval"/>, for a handler that awaits; used when both are set.</summary>
    public Func<Approval, ValueTask<ApprovalAnswer?>>? OnApprovalAsync { get; init; }

    /// <summary>Throws <see cref="TimeoutException"/> with the turn still running.</summary>
    public TimeSpan? Timeout { get; init; }

    /// <summary>Seconds the server may hold one poll; it caps at 60. Default 30.</summary>
    public int? PollWait { get; init; }
}

/// <summary>Options for <see cref="Session.RunAsync"/>: what <see cref="SendOptions"/> and <see cref="WaitOptions"/> take.</summary>
public sealed class RunOptions : SendOptions
{
    /// <inheritdoc cref="WaitOptions.OnApproval"/>
    public Func<Approval, ApprovalAnswer?>? OnApproval { get; init; }

    /// <inheritdoc cref="WaitOptions.OnApprovalAsync"/>
    public Func<Approval, ValueTask<ApprovalAnswer?>>? OnApprovalAsync { get; init; }

    /// <inheritdoc cref="WaitOptions.Timeout"/>
    public TimeSpan? Timeout { get; init; }

    /// <inheritdoc cref="WaitOptions.PollWait"/>
    public int? PollWait { get; init; }
}

/// <summary>A conversation with Sai on one computer. Sai decides every click.</summary>
public sealed class Sessions
{
    private readonly Http _http;
    private readonly Machines _machines;

    internal Sessions(Http http, Machines machines)
    {
        _http = http;
        _machines = machines;
    }

    /// <summary>
    /// Start a fresh conversation on a computer: the next message has no memory of earlier ones.
    /// <paramref name="machine"/> may be omitted with one computer.
    /// </summary>
    public async Task<Session> CreateAsync(MachineRef? machine = null, CancellationToken cancellationToken = default)
    {
        var machineId = await _machines.ResolveIdAsync(machine, cancellationToken).ConfigureAwait(false);
        string? sessionId = null;
        try
        {
            var d = await _http.JsonAsync(HttpMethod.Post, "/v1/agents/new-session",
                new RequestOptions { Json = new JsonObject { ["machineId"] = machineId, ["channel"] = "api" } },
                cancellationToken).ConfigureAwait(false);
            sessionId = d.Str("sessionId");
        }
        catch (NotFoundException)
        {
            // A free account's computer between claims has no conversation to rotate; the first message starts one.
        }
        return new Session(_http, machineId, sessionId);
    }

    /// <summary>
    /// The API sessions on a computer, most recent first (up to 20). <c>Active</c> marks the one the
    /// next message without a session goes to.
    /// </summary>
    public async Task<IReadOnlyList<SessionSummary>> ListAsync(MachineRef? machine = null, CancellationToken cancellationToken = default)
    {
        var machineId = await _machines.ResolveIdAsync(machine, cancellationToken).ConfigureAwait(false);
        var d = await _http.JsonAsync(HttpMethod.Get, "/v1/agents/sessions",
            new RequestOptions { Query = [new("machineId", machineId), new("channel", "api")] },
            cancellationToken).ConfigureAwait(false);
        return d.Arr("sessions").Select(SessionSummary.Parse).ToList();
    }

    /// <summary>Reattach to a session started elsewhere, e.g. to poll or abort it.</summary>
    public Session Resume(string sessionId, MachineRef? machine = null) =>
        new(_http, machine is { Id.Length: > 0 } ? machine.Id : null, sessionId);
}

/// <summary>A conversation with Sai. Each <see cref="SendAsync"/> is a turn; turns share context.</summary>
public sealed class Session
{
    private readonly Http _http;

    internal Session(Http http, string? machineId, string? id)
    {
        _http = http;
        MachineId = machineId;
        Id = id;
    }

    /// <summary>Null until the first message when the computer had no conversation yet.</summary>
    public string? Id { get; private set; }

    public string? MachineId { get; private set; }

    /// <summary>
    /// Give Sai a task, or steer the running one. Returns at once. Sent while a turn is running, the
    /// message steers that turn (<c>turn.Queued</c>). A structured message is refused with
    /// <see cref="ConflictException"/> (<c>session_busy</c>) while a turn is running.
    /// </summary>
    public async Task<Turn> SendAsync(string message, SendOptions? options = null, CancellationToken cancellationToken = default)
    {
        var o = options ?? new SendOptions();
        var body = new JsonObject { ["message"] = message, ["wait"] = false };
        if (MachineId is { Length: > 0 }) body["machineId"] = MachineId;
        if (Id is { Length: > 0 }) body["sessionId"] = Id;
        if (o.Model is { Length: > 0 }) body["model"] = o.Model;
        if (o.Attachments is { Count: > 0 })
            body["attachments"] = new JsonArray(o.Attachments.Select(a => (JsonNode?)J.ToNode(a.Raw)).ToArray());
        if (o.Autonomous) body["autonomous"] = true;
        var opts = new JsonObject();
        if (o.Inputs is not null) opts["inputs"] = J.ToNode(o.Inputs);
        if (o.OutputSchema is not null) opts["output_schema"] = J.ToNode(o.OutputSchema);
        if (o.SuccessCriteria is not null) opts["success_criteria"] = o.SuccessCriteria.ToJson();
        if (o.IdempotencyKey is not null) opts["idempotency_key"] = o.IdempotencyKey;
        if (o.RecordTrajectory) opts["recordTrajectory"] = true;
        if (o.ThinkingLevel is not null) opts["thinkingLevel"] = o.ThinkingLevel;
        if (opts.Count > 0) body["options"] = opts;
        var structured = o.Inputs is not null || o.OutputSchema is not null || o.SuccessCriteria is not null;

        var d = await _http.JsonAsync(HttpMethod.Post, "/v1/agents/message", new RequestOptions { Json = body }, cancellationToken)
            .ConfigureAwait(false);
        if (d.Truthy("idempotent_replay"))
        {
            // The key was used before: this is that turn, and nothing was sent.
            var record = TurnRecord.Parse(d);
            Id = record.SessionId ?? Id;
            if (record.MachineId.Length > 0) MachineId = record.MachineId;
            return new Turn(this, _http, false, null, record.Id, structured, record);
        }
        var sessionId = d.Str("sessionId");
        if (string.IsNullOrEmpty(sessionId))
        {
            // Handled without starting a task (e.g. a plain acknowledgement): the reply is in `reply`,
            // or in `error` on servers before `reply` existed.
            var text = d.Str("reply") ?? d.Str("error") ?? "";
            return new Turn(this, _http, false, Turn.LocalResult(Id ?? "", text), null, false, null);
        }
        Id = sessionId;
        if (d.Str("machineId") is { } m) MachineId = m;
        return new Turn(this, _http, d.Truthy("queued"), null, d.Str("turnId"), structured, null);
    }

    /// <summary><see cref="SendAsync"/> then <see cref="Turn.WaitAsync"/>: the answer, or where it stopped.</summary>
    public async Task<TurnResult> RunAsync(string message, RunOptions? options = null, CancellationToken cancellationToken = default)
    {
        var turn = await SendAsync(message, options, cancellationToken).ConfigureAwait(false);
        var wait = options is null
            ? null
            : new WaitOptions
            {
                OnApproval = options.OnApproval,
                OnApprovalAsync = options.OnApprovalAsync,
                Timeout = options.Timeout,
                PollWait = options.PollWait,
            };
        return await turn.WaitAsync(wait, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Stop the running turn. Pending approvals are denied. False if nothing was running.</summary>
    public async Task<bool> AbortAsync(CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(Id)) return false;
        var d = await _http.JsonAsync(HttpMethod.Post, "/v1/agents/abort",
            new RequestOptions { Json = new JsonObject { ["sessionId"] = Id } }, cancellationToken).ConfigureAwait(false);
        return d.Truthy("aborted");
    }

    /// <summary>
    /// Answer an approval: <c>yes</c>, <c>no</c>, or <c>task</c> (allow for the rest of the task). A
    /// <c>choice</c> approval needs <paramref name="selections"/>, one list of option values per
    /// question. Throws <see cref="LinkOnlyApprovalException"/> when only a browser can answer it.
    /// Returns <c>approved</c>, <c>approved_task</c> or <c>denied</c>.
    /// </summary>
    public Task<string> RespondAsync(
        Approval approval, string response = "yes", IReadOnlyList<IReadOnlyList<string>>? selections = null,
        CancellationToken cancellationToken = default)
    {
        if (approval.IsLinkOnly) throw LinkOnlyApprovalException.For(approval);
        return RespondAsync(approval.Id, response, selections, cancellationToken);
    }

    /// <summary>Answer an approval by its id.</summary>
    public async Task<string> RespondAsync(
        string approvalId, string response = "yes", IReadOnlyList<IReadOnlyList<string>>? selections = null,
        CancellationToken cancellationToken = default)
    {
        var body = new JsonObject { ["approvalId"] = approvalId, ["response"] = response };
        if (selections is not null) body["selections"] = J.ToNode(selections);
        var d = await _http.JsonAsync(HttpMethod.Post, "/v1/agents/approve", new RequestOptions { Json = body }, cancellationToken)
            .ConfigureAwait(false);
        return d.Str("status") ?? "";
    }
}

/// <summary>
/// One message's work. Iterate <see cref="EventsAsync"/> to watch it, or <see cref="WaitAsync"/> for
/// the result. <see cref="Id"/> is the turn the message started or joined; null when the message
/// was answered without one.
/// </summary>
public sealed class Turn
{
    private const int DefaultPollWait = 30;
    /// <summary>Between turn reads; <c>GET /v1/agents/turns/{id}</c> never holds.</summary>
    internal static readonly TimeSpan RecordPollInterval = TimeSpan.FromSeconds(2);
    // A turn that failed for these reasons still has the agent's answer; the turn itself did not break.
    private static readonly string[] AnsweredReasons = ["output_invalid", "criteria_not_met", "criteria_unchecked"];

    private readonly Http _http;
    private readonly bool _structured;
    private readonly TurnRecord? _replay;
    // answered without starting a task, or an idempotent replay: no events to poll
    private readonly bool _local;
    private string? _cursor;

    internal Turn(Session session, Http http, bool queued, TurnResult? done, string? id, bool structured, TurnRecord? replay)
    {
        Session = session;
        _http = http;
        Queued = queued;
        Result = done;
        Id = id;
        _structured = structured;
        _replay = replay;
        _local = done is not null || replay is not null;
    }

    public string? Id { get; }

    public Session Session { get; }

    /// <summary>True when the message steered a turn that was already running.</summary>
    public bool Queued { get; }

    /// <summary>One of <see cref="TurnStatus"/>.</summary>
    public string Status => Result?.Status ?? TurnStatus.Running;

    /// <summary>The last known state, or null before the first poll.</summary>
    public TurnResult? Result { get; private set; }

    /// <summary>
    /// Yield events until the turn is idle or errors. It keeps going through <c>needs_approval</c>:
    /// answer with <see cref="RespondAsync(Approval, string, IReadOnlyList{IReadOnlyList{string}}?, CancellationToken)"/>
    /// inside the loop. Without <paramref name="raw"/>, framing, reasoning and tool-call frames are skipped.
    /// </summary>
    public async IAsyncEnumerable<Event> EventsAsync(
        bool raw = false, int? pollWait = null, [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        if (_local) yield break;
        while (true)
        {
            var page = await PollAsync(pollWait ?? DefaultPollWait, cancellationToken).ConfigureAwait(false);
            foreach (var e in page.Arr("events"))
            {
                var ev = Event.Parse(e);
                if (raw || ev.Kind != EventKind.Other) yield return ev;
            }
            if (page.Str("status") is TurnStatus.Idle or TurnStatus.Error) yield break;
        }
    }

    /// <summary>
    /// Wait until the turn is done, or stops on an approval nobody answered. Without a handler,
    /// returns with <c>Status == "needs_approval"</c> and the approval. With one, the handler's answer
    /// is sent and waiting continues. For a structured message, it then waits for the turn's record.
    /// </summary>
    public async Task<TurnResult> WaitAsync(WaitOptions? options = null, CancellationToken cancellationToken = default)
    {
        var o = options ?? new WaitOptions();
        DateTimeOffset? deadline = o.Timeout is { } t ? DateTimeOffset.UtcNow + t : null;
        if (_replay is not null)
        {
            var record = _replay.Done ? _replay : await WaitRecordAsync(_http, _replay.Id, deadline, null, cancellationToken).ConfigureAwait(false);
            Result = ReplayResult(record, record.SessionId ?? Session.Id ?? "");
            return Result;
        }
        if (_local) return Result!;
        var answered = new HashSet<string>();
        while (true)
        {
            var pollWait = o.PollWait ?? DefaultPollWait;
            if (deadline is { } dl)
            {
                var left = dl - DateTimeOffset.UtcNow;
                if (left <= TimeSpan.Zero)
                    throw new TimeoutException($"Turn still {Status} after {o.Timeout!.Value.TotalMilliseconds}ms (session {Session.Id}).");
                pollWait = Math.Max(1, Math.Min(pollWait, (int)Math.Floor(left.TotalSeconds)));
            }
            var page = await PollAsync(pollWait, cancellationToken).ConfigureAwait(false);
            var status = page.Str("status");
            if (status is TurnStatus.Idle or TurnStatus.Error)
            {
                if (_structured && Id is not null)
                {
                    var record = await WaitRecordAsync(_http, Id, deadline, null, cancellationToken).ConfigureAwait(false);
                    Result = Result! with { Record = record };
                }
                return Result!;
            }
            var approval = Result?.Approval;
            if (status != TurnStatus.NeedsApproval || approval is null) continue;
            if (o.OnApproval is null && o.OnApprovalAsync is null) return Result!;
            if (!answered.Add(approval.Id)) continue;
            var answer = o.OnApprovalAsync is not null
                ? await o.OnApprovalAsync(approval).ConfigureAwait(false)
                : o.OnApproval!(approval);
            if (answer is null) continue;
            try
            {
                await Session.RespondAsync(approval, answer.Response, answer.Selections, cancellationToken).ConfigureAwait(false);
            }
            catch (ConflictException)
            {
                // answered elsewhere or expired; the next poll shows the new state
            }
        }
    }

    /// <inheritdoc cref="Session.RespondAsync(Approval, string, IReadOnlyList{IReadOnlyList{string}}?, CancellationToken)"/>
    public Task<string> RespondAsync(
        Approval approval, string response = "yes", IReadOnlyList<IReadOnlyList<string>>? selections = null,
        CancellationToken cancellationToken = default) =>
        Session.RespondAsync(approval, response, selections, cancellationToken);

    /// <inheritdoc cref="Session.RespondAsync(string, string, IReadOnlyList{IReadOnlyList{string}}?, CancellationToken)"/>
    public Task<string> RespondAsync(
        string approvalId, string response = "yes", IReadOnlyList<IReadOnlyList<string>>? selections = null,
        CancellationToken cancellationToken = default) =>
        Session.RespondAsync(approvalId, response, selections, cancellationToken);

    /// <inheritdoc cref="Session.AbortAsync"/>
    public Task<bool> AbortAsync(CancellationToken cancellationToken = default) => Session.AbortAsync(cancellationToken);

    private async Task<JsonElement> PollAsync(int wait, CancellationToken cancellationToken)
    {
        JsonElement page;
        while (true)
        {
            try
            {
                page = await _http.JsonAsync(HttpMethod.Get, "/v1/agents/events", new RequestOptions
                {
                    Query = [new("sessionId", Session.Id ?? ""), new("wait", wait.ToString(System.Globalization.CultureInfo.InvariantCulture)), new("since", _cursor)],
                    Timeout = TimeSpan.FromSeconds(wait + 30),
                }, cancellationToken).ConfigureAwait(false);
                break;
            }
            catch (RateLimitException e)
            {
                await Task.Delay(TimeSpan.FromSeconds(e.RetryAfter ?? 30), cancellationToken).ConfigureAwait(false);
            }
        }
        _cursor = page.Str("cursor") ?? _cursor;
        var error = Result?.Error;
        var errorCode = Result?.ErrorCode;
        foreach (var e in page.Arr("events"))
        {
            if (e.Str("type") != "error") continue;
            error = e.Str("errorText") ?? error;
            errorCode = e.Str("code") ?? errorCode;
        }
        var approval = page.Get("approval");
        Result = new TurnResult(
            page.Str("status") ?? TurnStatus.Running, page.Str("text") ?? "", page.Str("sessionId") ?? Session.Id ?? "",
            approval.Truthy() ? Approval.Parse(approval) : null, error, errorCode, Usage.Parse(page.Get("usage")),
            Usage.Parse(page.Get("sessionUsage")), null);
        return page;
    }

    /// <summary>
    /// Read the turn's record until its status is in <paramref name="stop"/> (default: succeeded or
    /// failed). Throws <see cref="TimeoutException"/> past <paramref name="deadline"/>.
    /// </summary>
    internal static async Task<TurnRecord> WaitRecordAsync(
        Http http, string turnId, DateTimeOffset? deadline, string[]? stop, CancellationToken cancellationToken)
    {
        stop ??= [TurnRecordStatus.Succeeded, TurnRecordStatus.Failed];
        while (true)
        {
            TurnRecord record;
            try
            {
                record = TurnRecord.Parse(await http.JsonAsync(HttpMethod.Get, $"/v1/agents/turns/{Http.Q(turnId)}", null, cancellationToken)
                    .ConfigureAwait(false));
            }
            catch (RateLimitException e)
            {
                await Task.Delay(TimeSpan.FromSeconds(e.RetryAfter ?? 30), cancellationToken).ConfigureAwait(false);
                continue;
            }
            if (stop.Contains(record.Status)) return record;
            if (deadline is { } dl && DateTimeOffset.UtcNow + RecordPollInterval > dl)
                throw new TimeoutException($"Turn {turnId} still {record.Status}.");
            await Task.Delay(RecordPollInterval, cancellationToken).ConfigureAwait(false);
        }
    }

    internal static TurnResult LocalResult(string sessionId, string text) =>
        new(TurnStatus.Idle, text, sessionId, null, null, null, null, null, null);

    /// <summary>The result the live path would have returned for this finished turn, from its record.</summary>
    private static TurnResult ReplayResult(TurnRecord record, string sessionId)
    {
        var result = LocalResult(sessionId, record.RawAnswer is { Length: > 0 } a ? a : OutputText(record.Output));
        if (record.Status == TurnRecordStatus.Failed && !AnsweredReasons.Contains(record.ReasonCode ?? ""))
        {
            result = result with
            {
                Status = TurnStatus.Error,
                Text = "",
                Error = record.RawAnswer is { Length: > 0 } r ? r : $"The turn failed ({record.ReasonCode ?? "unknown"}).",
                ErrorCode = record.ErrorCode,
            };
        }
        return result with { Usage = record.Usage, Record = record };
    }

    /// <summary><c>output</c> as text: a plain message's answer as is, an output-schema object as JSON.</summary>
    private static string OutputText(JsonElement? output) => output switch
    {
        null => "",
        { ValueKind: JsonValueKind.String } s => s.GetString()!,
        { } o => J.Stringify(JsonNode.Parse(o.GetRawText())),
    };
}
