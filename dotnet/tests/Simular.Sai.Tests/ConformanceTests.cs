using System.Collections;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Simular.Sai.Tests;

/// <summary>
/// The shared conformance suite (../../conformance/README.md): each case's steps become calls on this
/// SDK, against the mock server, which checks the requests and the outcomes.
/// </summary>
public class ConformanceTests(MockServer server) : IClassFixture<MockServer>
{
    private static readonly Dictionary<string, JsonElement> Cases = Directory
        .GetFiles(Path.Combine(Repo.Conformance, "cases"), "*.json")
        .Order(StringComparer.Ordinal)
        .SelectMany(f => JsonDocument.Parse(File.ReadAllText(f)).RootElement.GetProperty("cases").EnumerateArray())
        .ToDictionary(c => c.GetProperty("id").GetString()!, c => c);

    public static TheoryData<string> CaseIds() => new(Cases.Keys);

    [Theory(Timeout = 60_000)]
    [MemberData(nameof(CaseIds))]
    public async Task Case(string id)
    {
        var c = Cases[id];
        await server.ControlAsync("start", new JsonObject { ["case"] = id });
        var client = c.TryGetProperty("client", out var o) ? o : default;
        using var sai = new SaiClient(new SaiClientOptions
        {
            ApiKey = Str(client, "api_key") ?? "sapi_test",
            BaseUrl = server.Url,
            OrgId = Str(client, "org_id") ?? "",
            VersionTag = Str(client, "version_tag"),
        });
        var saved = new Dictionary<string, object?> { ["client"] = sai };
        var index = 0;
        foreach (var step in c.GetProperty("steps").EnumerateArray())
        {
            var outcome = new JsonObject { ["index"] = index++ };
            try
            {
                var value = await InvokeAsync(saved, step);
                outcome["result"] = Project(value);
                if (Str(step, "save") is { } name)
                    saved[name] = Str(step, "pick") is { } path ? Pick(value, path) : value;
            }
            catch (Exception e)
            {
                outcome["error"] = ProjectError(e);
            }
            await server.ControlAsync("step", outcome);
        }
        var finish = await server.ControlAsync("finish", new JsonObject());
        Assert.Equal("[]", finish!["failures"]!.ToJsonString());
    }

    private static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    // ─── Calls ───────────────────────────────────────────────────────────────

    private sealed class Args(Dictionary<string, object?> saved, JsonElement args)
    {
        public bool Has(string k) => args.ValueKind == JsonValueKind.Object && args.TryGetProperty(k, out _);

        public JsonElement this[string k] => Has(k) ? args.GetProperty(k) : default;

        public string S(string k) => this[k].GetString()!;

        public string? OptS(string k) => Has(k) && this[k].ValueKind == JsonValueKind.String ? this[k].GetString() : null;

        public int? OptI(string k) => Has(k) && this[k].ValueKind == JsonValueKind.Number ? this[k].GetInt32() : null;

        public bool? OptB(string k) => Has(k) && this[k].ValueKind is JsonValueKind.True or JsonValueKind.False ? this[k].GetBoolean() : null;

        public TimeSpan? OptMs(string k) => OptI(k) is { } ms ? TimeSpan.FromMilliseconds(ms) : null;

        /// <summary>An id string, or the object an earlier step saved (<c>{ "$ref": name }</c>).</summary>
        public object? Ref(JsonElement v) =>
            v.ValueKind == JsonValueKind.Object && v.TryGetProperty("$ref", out var r)
                ? saved.TryGetValue(r.GetString()!, out var x) ? x : throw new InvalidOperationException($"nothing saved as {r}")
                : v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        public object? Ref(string k) => Has(k) ? Ref(this[k]) : null;

        public MachineRef? Machine(string k = "machine") => Ref(k) switch
        {
            null => null,
            string s => s,
            Machine m => m,
            var x => throw new InvalidOperationException($"not a machine: {x}"),
        };

        public TenantRef Tenant() => Ref("tenant") switch
        {
            string s => s,
            Tenant t => t,
            var x => throw new InvalidOperationException($"not a tenant: {x}"),
        };

        public TenantMachineRef TenantMachine() => Ref("machine") switch
        {
            string s => s,
            TenantMachine m => m,
            var x => throw new InvalidOperationException($"not a tenant machine: {x}"),
        };

        public TurnRef Turn(JsonElement v) => Ref(v) switch
        {
            string s => s,
            Turn t => t,
            TurnRecord r => r,
            var x => throw new InvalidOperationException($"not a turn: {x}"),
        };

        public LearnRef Job() => Ref("job") switch
        {
            string s => s,
            LearnResult r => r,
            var x => throw new InvalidOperationException($"not a learn job: {x}"),
        };

        public List<TurnRef> Turns() => this["turns"].EnumerateArray().Select(Turn).ToList();

        public Dictionary<string, object>? Map(string k) =>
            Has(k) ? this[k].EnumerateObject().ToDictionary(p => p.Name, p => (object)p.Value.Clone()) : null;

        public Dictionary<string, string>? StringMap(string k) =>
            Has(k) ? this[k].EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString()!) : null;

        public Criteria? Criteria(string k) => !Has(k)
            ? null
            : this[k].ValueKind == JsonValueKind.String
                ? this[k].GetString()!
                : this[k].EnumerateArray().Select(c => new Check(
                    c.GetProperty("id").GetString()!, c.GetProperty("check").GetString()!,
                    c.TryGetProperty("return_evidence", out var r) && r.GetBoolean())).ToArray();

        public IReadOnlyList<IReadOnlyList<string>>? Selections(JsonElement v) =>
            v.ValueKind == JsonValueKind.Array
                ? v.EnumerateArray().Select(q => (IReadOnlyList<string>)q.EnumerateArray().Select(x => x.GetString()!).ToList()).ToList()
                : null;

        public SendOptions Send() => Run();

        public RunOptions Run()
        {
            Func<Approval, ApprovalAnswer?>? handler = null;
            if (Has("on_approval"))
            {
                var answers = new Queue<JsonElement>(this["on_approval"].GetProperty("answers").EnumerateArray());
                handler = _ =>
                {
                    if (answers.Count == 0) return null;
                    var a = answers.Dequeue();
                    return a.ValueKind switch
                    {
                        JsonValueKind.String => a.GetString()!,
                        JsonValueKind.Array => new ApprovalAnswer(a[0].GetString()!, Selections(a[1])),
                        _ => null,
                    };
                };
            }
            return new RunOptions
            {
                Model = OptS("model"),
                Attachments = Has("attachments") ? this["attachments"].EnumerateArray().Select(a => (Attachment)Ref(a)!).ToList() : null,
                Inputs = Map("inputs"),
                OutputSchema = Has("output_schema") ? this["output_schema"].Clone() : null,
                SuccessCriteria = Criteria("success_criteria"),
                IdempotencyKey = OptS("idempotency_key"),
                RecordTrajectory = OptB("record_trajectory") ?? false,
                ThinkingLevel = OptS("thinking_level"),
                Autonomous = OptB("autonomous") ?? false,
                OnApproval = handler,
                PollWait = OptI("poll_wait"),
            };
        }

        public WaitOptions Wait()
        {
            var r = Run();
            return new WaitOptions { OnApproval = r.OnApproval, PollWait = r.PollWait };
        }

        public Reset? Reset() => !Has("reset")
            ? null
            : this["reset"].TryGetProperty("code", out var code) ? Sai.Reset.Code(code.GetString()!) : Sai.Reset.Task(this["reset"].GetProperty("task").GetString()!);

        public LearnOptions Learn() => new()
        {
            TaskTemplate = OptS("task_template"),
            Inputs = Map("inputs"),
            InitialCode = OptS("initial_code"),
            Evaluations = Has("evaluations")
                ? this["evaluations"].EnumerateArray().Select(e => new Evaluation(
                    e.GetProperty("inputs").EnumerateObject().ToDictionary(p => p.Name, p => (object)p.Value.Clone()),
                    e.TryGetProperty("result", out var r) ? (ExecResult)Ref(r)! : null,
                    e.TryGetProperty("judgement", out var j) ? (JudgementRef)j.GetString()! : null,
                    e.TryGetProperty("passed", out var p) ? p.GetBoolean() : null,
                    e.TryGetProperty("note", out var n) ? n.GetString() : null)).ToList()
                : null,
            Guidance = OptS("guidance"),
            History = OptS("history"),
            RunsWithoutReset = OptB("runs_without_reset"),
            MaxIterations = OptI("max_iterations"),
            Rollouts = OptI("rollouts"),
            Machine = Machine(),
            Criteria = Criteria("criteria"),
            Reset = Reset(),
            JudgeInitialAgentRun = OptB("judge_initial_agent_run"),
            ContinueWithAgent = OptB("continue_with_agent"),
            RolloutMinutes = OptI("rollout_minutes"),
            AgentRunMinutes = OptI("agent_run_minutes"),
            ContinuationMinutes = OptI("continuation_minutes"),
            MaxJobMinutes = OptI("max_job_minutes"),
            Model = OptS("model"),
            IdempotencyKey = OptS("idempotency_key"),
        };

        public TenantUpdate Update()
        {
            var limit = this["cloud_machine_limit"];
            return Has("cloud_machine_limit")
                ? new TenantUpdate
                {
                    Name = OptS("name"),
                    Metadata = StringMap("metadata"),
                    Status = OptS("status"),
                    ResidentialProxy = OptB("residential_proxy"),
                    CloudMachineLimit = limit.ValueKind == JsonValueKind.Number ? limit.GetInt64() : null,
                }
                : new TenantUpdate
                {
                    Name = OptS("name"),
                    Metadata = StringMap("metadata"),
                    Status = OptS("status"),
                    ResidentialProxy = OptB("residential_proxy"),
                };
        }
    }

    private static async Task<object?> InvokeAsync(Dictionary<string, object?> saved, JsonElement step)
    {
        var parts = step.GetProperty("call").GetString()!.Split('.');
        var (target, method) = parts[0] != "client" && saved.TryGetValue(parts[0], out var t)
            ? (t, string.Join('.', parts[1..]))
            : (saved["client"], string.Join('.', parts));
        var a = new Args(saved, step.TryGetProperty("args", out var args) ? args : default);
        return target switch
        {
            SaiClient sai => await CallClientAsync(sai, method, a),
            Session s => await CallSessionAsync(s, method, a),
            Turn turn => await CallTurnAsync(turn, method, a),
            ControlLease l => await CallLeaseAsync(l, method, a),
            _ => throw new InvalidOperationException($"no target for {step.GetProperty("call")}"),
        };
    }

    private const object? Nothing = null;

    private static async Task<object?> CallClientAsync(SaiClient sai, string method, Args a)
    {
        switch (method)
        {
            case "machines.list": return await sai.Machines.ListAsync();
            case "machines.get": return await sai.Machines.GetAsync(a.S("machine_id"));
            case "machines.live": return await sai.Machines.LiveAsync(a.Machine()!);
            case "machines.revoke_live": return await sai.Machines.RevokeLiveAsync(a.Machine()!);
            case "sessions.create": return await sai.Sessions.CreateAsync(a.Machine());
            case "sessions.resume": return sai.Sessions.Resume(a.S("session_id"), a.Machine());
            case "sessions.list": return await sai.Sessions.ListAsync(a.Machine());
            case "turns.get": return await sai.Turns.GetAsync(a.Turn(a["turn"]));
            case "turns.wait": return await sai.Turns.WaitAsync(a.Turn(a["turn"]));
            case "turns.trajectory": return await sai.Turns.TrajectoryAsync(a.Turn(a["turn"]));
            case "turns.screenshot": return await sai.Turns.ScreenshotAsync(a.Turn(a["turn"]), a.OptI("index")!.Value);
            case "learn.create": return await sai.Learn.CreateAsync(a.Turns(), a.Learn());
            case "learn.get": return await sai.Learn.GetAsync(a.S("learn_id"));
            case "learn.wait": return await sai.Learn.WaitAsync(a.Job(), pollInterval: a.OptMs("poll_ms"));
            case "learn.cancel": await sai.Learn.CancelAsync(a.Job()); return Nothing;
            case "learn.rollout": return await sai.Learn.RolloutAsync(a.Job(), a.OptI("iteration")!.Value, a.OptI("rollout")!.Value);
            case "judge.create":
                return await sai.Judge.CreateAsync(a.Turns(), a.Criteria("criteria")!,
                    new JudgeOptions { Task = a.OptS("task"), IdempotencyKey = a.OptS("idempotency_key") });
            case "judge.get": return await sai.Judge.GetAsync(a.S("judgement_id"));
            case "control.open": return await sai.Control.OpenAsync(a.Machine()!);
            case "models.list": return await sai.Models.ListAsync();
            case "files.upload": return await sai.Files.UploadAsync(Convert.FromBase64String(a.S("data_base64")), a.S("name"));
            case "account.get": return await sai.Account.GetAsync();
            case "auth.check": return await sai.Auth.CheckAsync();
            case "usage.get": return await sai.Usage.GetAsync(a.OptS("granularity"), a.OptS("from"), a.OptS("to"), a.OptS("org_id"));
            case "usage.sessions":
                return await sai.Usage.SessionsAsync(a.Tenant(), a.S("from"), a.S("to"), a.OptI("limit"), a.OptS("cursor"), a.OptS("org_id"));
            case "tenants.create": return await sai.Tenants.CreateAsync(a.S("name"), a.OptS("external_id"), a.StringMap("metadata"));
            case "tenants.list": return await sai.Tenants.ListAsync(a.OptS("status"), a.OptS("external_id"), a.OptI("limit"), a.OptS("cursor"));
            case "tenants.get": return await sai.Tenants.GetAsync(a.Tenant());
            case "tenants.update": return await sai.Tenants.UpdateAsync(a.Tenant(), a.Update());
            case "tenants.delete": await sai.Tenants.DeleteAsync(a.Tenant()); return Nothing;
            case "tenants.create_enrollment": return await sai.Tenants.CreateEnrollmentAsync(a.Tenant());
            case "tenants.token": return await sai.Tenants.TokenAsync(a.Tenant(), a.OptS("org_id"));
            case "tenants.client": return await sai.Tenants.ClientAsync(a.Tenant(), a.OptS("org_id"));
            case "tenant_machines.create":
                return await sai.TenantMachines.CreateAsync(a.Tenant(), a.S("os"), a.OptS("name"), a.OptS("request_id"), a.OptB("wait") ?? false);
            case "tenant_machines.list": return await sai.TenantMachines.ListAsync(a.Tenant());
            case "tenant_machines.get": return await sai.TenantMachines.GetAsync(a.Tenant(), a.S("machine_id"));
            case "tenant_machines.delete": return await sai.TenantMachines.DeleteAsync(a.Tenant(), a.TenantMachine());
            case "tenant_machines.revoke": await sai.TenantMachines.RevokeAsync(a.Tenant(), a.TenantMachine()); return Nothing;
        }
        throw new InvalidOperationException($"unknown call client.{method}");
    }

    private static Task<string> Respond(Func<Approval, string, IReadOnlyList<IReadOnlyList<string>>?, Task<string>> byApproval,
        Func<string, string, IReadOnlyList<IReadOnlyList<string>>?, Task<string>> byId, Args a)
    {
        var response = a.OptS("response") ?? "yes";
        var selections = a.Selections(a["selections"]);
        return a.Ref("approval") switch
        {
            Approval approval => byApproval(approval, response, selections),
            string id => byId(id, response, selections),
            var x => throw new InvalidOperationException($"not an approval: {x}"),
        };
    }

    private static async Task<object?> CallSessionAsync(Session s, string method, Args a) => method switch
    {
        "send" => await s.SendAsync(a.S("message"), a.Send()),
        "run" => await s.RunAsync(a.S("message"), a.Run()),
        "abort" => await s.AbortAsync(),
        "respond" => await Respond((x, r, sel) => s.RespondAsync(x, r, sel), (x, r, sel) => s.RespondAsync(x, r, sel), a),
        _ => throw new InvalidOperationException($"unknown call Session.{method}"),
    };

    private static async Task<object?> CallTurnAsync(Turn t, string method, Args a)
    {
        switch (method)
        {
            case "events":
                var events = new List<Event>();
                await foreach (var ev in t.EventsAsync(a.OptB("raw") ?? false, a.OptI("poll_wait"))) events.Add(ev);
                return events;
            case "wait": return await t.WaitAsync(a.Wait());
            case "respond": return await Respond((x, r, sel) => t.RespondAsync(x, r, sel), (x, r, sel) => t.RespondAsync(x, r, sel), a);
            case "abort": return await t.AbortAsync();
        }
        throw new InvalidOperationException($"unknown call Turn.{method}");
    }

    private static async Task<object?> CallLeaseAsync(ControlLease l, string method, Args a)
    {
        switch (method)
        {
            case "exec": return await l.ExecAsync(a.S("code"), a.OptMs("timeout_ms"));
            case "run":
                return a.Ref("learned") switch
                {
                    LearnResult learned => await l.RunAsync(learned, a.Map("inputs"), a.OptMs("timeout_ms")),
                    string code => await l.RunAsync(code, a.Map("inputs"), a.OptMs("timeout_ms")),
                    var x => throw new InvalidOperationException($"not learned code: {x}"),
                };
            case "shell": return await l.ShellAsync(a.S("command"), a.OptS("cwd"), a.OptMs("timeout_ms"));
            case "read_file": return await l.ReadFileAsync(a.S("path"));
            case "write_file": await l.WriteFileAsync(a.S("path"), a.S("text")); return Nothing;
            case "screenshot": return await l.ScreenshotAsync();
            case "interrupt": return await l.InterruptAsync();
            case "get": return await l.GetAsync();
            case "close": await l.CloseAsync(); return Nothing;
        }
        throw new InvalidOperationException($"unknown call ControlLease.{method}");
    }

    /// <summary>A dotted path of snake_case field names and list indexes.</summary>
    private static object? Pick(object? value, string path)
    {
        foreach (var part in path.Split('.'))
        {
            value = value is IList list
                ? list[int.Parse(part, System.Globalization.CultureInfo.InvariantCulture)]
                : value!.GetType().GetProperty(SurfaceTests.Pascal(part))!.GetValue(value);
        }
        return value;
    }

    // ─── Projection ──────────────────────────────────────────────────────────

    private static JsonNode? Project(object? v) => v switch
    {
        null => null,
        JsonElement e => e.ValueKind is JsonValueKind.Undefined ? null : JsonNode.Parse(e.GetRawText()),
        string s => s,
        bool b => b,
        int i => i,
        long l => l,
        double d => d,
        byte[] bytes => new JsonObject { ["$base64"] = Convert.ToBase64String(bytes) },
        SaiClient => new JsonObject(),
        Session s => new JsonObject { ["id"] = s.Id, ["machine_id"] = s.MachineId },
        Turn t => new JsonObject { ["id"] = t.Id, ["queued"] = t.Queued, ["status"] = t.Status },
        ControlLease l => new JsonObject { ["machine_id"] = l.MachineId, ["idle_timeout_sec"] = l.IdleTimeoutSec },
        // Maps keyed by ids or names: the keys stay, the values are projected.
        IDictionary map => new JsonObject(map.Keys.Cast<object>().Select(k =>
            KeyValuePair.Create(k.ToString()!, Project(map[k])))),
        IEnumerable list => new JsonArray(list.Cast<object?>().Select(Project).ToArray()),
        _ => ProjectObject(v),
    };

    private static JsonObject ProjectObject(object v)
    {
        var o = new JsonObject();
        foreach (var p in v.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (p.Name == "Raw" || p.GetIndexParameters().Length > 0) continue;
            o[SurfaceTests.Snake(p.Name)] = Project(p.GetValue(v));
        }
        return o;
    }

    private static JsonObject ProjectError(Exception err)
    {
        if (err is not SaiException e)
            return new JsonObject { ["class"] = err.GetType().Name, ["message"] = err.Message };
        var o = new JsonObject
        {
            ["class"] = SurfaceTests.ErrorName(e.GetType()),
            ["status"] = e.Status,
            ["code"] = e.Code,
            ["message"] = e.Message,
            ["retry_after"] = e.RetryAfter,
            ["body"] = Project(e.Body),
        };
        if (e is LinkOnlyApprovalException link) o["approval_url"] = link.ApprovalUrl;
        if (e is SpendCapReachedException cap) o["resets_at"] = cap.ResetsAt;
        if (e is BlockException block) o["kind"] = block.Kind;
        return o;
    }
}
