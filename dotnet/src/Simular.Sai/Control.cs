using System.Text.Json;
using System.Text.Json.Nodes;

namespace Simular.Sai;

/// <summary>
/// Direct control: drive a computer with Simulang. No agent. A lease on the machine: at most
/// one per machine. Research preview; model calls the code makes are billed as usual.
/// </summary>
public sealed class Control
{
    private readonly Http _http;

    internal Control(Http http) => _http = http;

    /// <summary>
    /// Take a computer. Returns once the lease holds it, up to ~3 minutes when a Sai task holds
    /// it or it has to start; at once if the lease is already open. Close it when done
    /// (<c>await using</c>): Sai's tasks on that computer wait until then.
    /// </summary>
    public async Task<ControlLease> OpenAsync(MachineRef machine, CancellationToken cancellationToken = default)
    {
        var d = await _http.JsonAsync(HttpMethod.Post, ControlLease.PathOf(machine.Id),
            new RequestOptions { Timeout = TimeSpan.FromSeconds(240) }, cancellationToken).ConfigureAwait(false);
        return new ControlLease(_http, machine.Id, d.Int("expiresAfterIdleSec") ?? 0);
    }
}

/// <summary>A control lease on one computer. Dispose it (<c>await using</c>) to release the computer.</summary>
public sealed class ControlLease : IAsyncDisposable
{
    private readonly Http _http;
    private readonly string _path;
    private bool _closed;

    internal ControlLease(Http http, string machineId, int idleTimeoutSec)
    {
        _http = http;
        MachineId = machineId;
        IdleTimeoutSec = idleTimeoutSec;
        _path = PathOf(machineId);
    }

    public string MachineId { get; }

    /// <summary>Seconds the lease may sit idle before it ends.</summary>
    public int IdleTimeoutSec { get; }

    internal static string PathOf(string machineId) => $"/v1/machines/{Http.Q(machineId)}/control";

    /// <summary>
    /// Run one Simulang (JavaScript) block. Use <c>var</c> for anything the next block needs. A block
    /// that throws, times out or is interrupted still returns: check <c>result.Error</c>. Throws
    /// <see cref="GoneException"/> once the lease has ended: open again.
    /// </summary>
    public async Task<ExecResult> ExecAsync(string code, TimeSpan? timeout = null, CancellationToken cancellationToken = default)
    {
        var body = new JsonObject { ["code"] = code };
        if (timeout is { } t) body["timeoutMs"] = (long)t.TotalMilliseconds;
        var d = await _http.JsonAsync(HttpMethod.Post, $"{_path}/exec", new RequestOptions
        {
            Json = body,
            Timeout = (timeout ?? TimeSpan.FromMilliseconds(120_000)) + TimeSpan.FromMilliseconds(45_000),
        }, cancellationToken).ConfigureAwait(false);
        return ExecResult.Parse(d);
    }

    /// <summary>
    /// Run code from <c>Learn.CreateAsync</c>: its <c>main</c> with <paramref name="inputs"/> over the
    /// parameters' defaults. <c>main</c>'s return value is <c>result.Result</c>.
    /// </summary>
    public Task<ExecResult> RunAsync(
        LearnResult learned, IReadOnlyDictionary<string, object>? inputs = null, TimeSpan? timeout = null,
        CancellationToken cancellationToken = default)
    {
        var args = new JsonObject();
        foreach (var p in learned.Parameters) args[p.Name] = p.DefaultValue;
        return RunCodeAsync(learned.Code, args, inputs, timeout, cancellationToken);
    }

    /// <summary>Run <paramref name="code"/>'s <c>main</c> with <paramref name="inputs"/> as they are.</summary>
    public Task<ExecResult> RunAsync(
        string code, IReadOnlyDictionary<string, object>? inputs = null, TimeSpan? timeout = null,
        CancellationToken cancellationToken = default) =>
        RunCodeAsync(code, new JsonObject(), inputs, timeout, cancellationToken);

    private Task<ExecResult> RunCodeAsync(
        string code, JsonObject args, IReadOnlyDictionary<string, object>? inputs, TimeSpan? timeout, CancellationToken cancellationToken)
    {
        foreach (var (k, v) in inputs ?? new Dictionary<string, object>()) args[k] = J.ToNode(v);
        return ExecAsync($"{code}\nawait main({J.Stringify(args)})", timeout, cancellationToken);
    }

    /// <summary>Run a shell command on the computer.</summary>
    public async Task<ShellResult> ShellAsync(
        string command, string? cwd = null, TimeSpan? timeout = null, CancellationToken cancellationToken = default)
    {
        var args = new JsonObject { ["command"] = command };
        if (!string.IsNullOrEmpty(cwd)) args["cwd"] = cwd;
        var r = Check(await ExecAsync($"await machine.exec({J.Stringify(args)})", timeout, cancellationToken).ConfigureAwait(false));
        var v = r.Result ?? default;
        return new ShellResult(v.Str("stdout") ?? "", v.Str("stderr") ?? "", v.Int("exitCode") ?? 0, v.Truthy("timedOut"));
    }

    public async Task<string> ReadFileAsync(string path, CancellationToken cancellationToken = default)
    {
        var r = Check(await ExecAsync($"await machine.readFile({J.Stringify(new JsonObject { ["path"] = path })})", null, cancellationToken)
            .ConfigureAwait(false));
        return r.Result is { ValueKind: JsonValueKind.String } s ? s.GetString()! : r.Result?.GetRawText() ?? "";
    }

    public async Task WriteFileAsync(string path, string text, CancellationToken cancellationToken = default)
    {
        var args = new JsonObject { ["path"] = path, ["text"] = text, ["overwrite"] = true };
        Check(await ExecAsync($"await machine.writeToFile({J.Stringify(args)})", null, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>
    /// The whole screen as image bytes (usually JPEG; use <see cref="ExecAsync"/> for the MIME type).
    /// Needs the computer's screen-capture service; throws <see cref="BlockException"/> where it is off.
    /// </summary>
    public async Task<byte[]> ScreenshotAsync(CancellationToken cancellationToken = default)
    {
        var r = Check(await ExecAsync("var __sai_page = await machine.pageContent(); null", null, cancellationToken).ConfigureAwait(false));
        return r.Screenshot
            ?? throw new BlockException("exception", r.ScreenshotOmitted ? "screenshot too large to return" : "no screenshot");
    }

    /// <summary>Stop the running block at its next step. False if nothing was running.</summary>
    public async Task<bool> InterruptAsync(CancellationToken cancellationToken = default)
    {
        var d = await _http.JsonAsync(HttpMethod.Post, $"{_path}/interrupt", null, cancellationToken).ConfigureAwait(false);
        return d.Truthy("interrupted");
    }

    /// <summary>The lease's state: <c>{ status: open|closed, closedReason?, lastExecAt, ... }</c>.</summary>
    public Task<JsonElement> GetAsync(CancellationToken cancellationToken = default) =>
        _http.JsonAsync(HttpMethod.Get, _path, null, cancellationToken);

    /// <summary>Clear the REPL and release the computer. Safe to call twice.</summary>
    public async Task CloseAsync(CancellationToken cancellationToken = default)
    {
        if (_closed) return;
        try
        {
            await _http.RequestAsync(HttpMethod.Delete, _path, null, cancellationToken).ConfigureAwait(false);
        }
        catch (GoneException)
        {
        }
        _closed = true;
    }

    public async ValueTask DisposeAsync() => await CloseAsync().ConfigureAwait(false);

    private static ExecResult Check(ExecResult r) =>
        r.Error is { } e ? throw new BlockException(e.Kind, e.Message) : r;
}
