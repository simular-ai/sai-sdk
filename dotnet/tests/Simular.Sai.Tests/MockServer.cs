using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace Simular.Sai.Tests;

internal static class Repo
{
    /// <summary>The sai-sdk checkout: the directory above this test's output that holds surface.json.</summary>
    public static string Root { get; } = FindRoot();

    public static string Conformance => Path.Combine(Root, "conformance");

    private static string FindRoot()
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d is not null; d = d.Parent)
            if (File.Exists(Path.Combine(d.FullName, "surface.json"))) return d.FullName;
        throw new InvalidOperationException("surface.json not found above " + AppContext.BaseDirectory);
    }

    public static ProcessStartInfo Node(params string[] args)
    {
        var psi = new ProcessStartInfo("node") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        foreach (var a in args) psi.ArgumentList.Add(a);
        return psi;
    }
}

/// <summary>
/// <c>node conformance/server.mjs</c>, the mock Sai API. Its stdin stays open: the server exits when
/// this test run does.
/// </summary>
public sealed class MockServer : IAsyncLifetime
{
    private Process? _process;

    public HttpClient Http { get; } = new();

    public string Url { get; private set; } = "";

    public async ValueTask InitializeAsync()
    {
        var psi = Repo.Node(Path.Combine(Repo.Conformance, "server.mjs"));
        psi.RedirectStandardInput = true;
        psi.RedirectStandardError = false;
        _process = Process.Start(psi)!;
        var line = await _process.StandardOutput.ReadLineAsync() ?? "";
        if (!line.StartsWith("SAI_MOCK_URL=", StringComparison.Ordinal))
            throw new InvalidOperationException($"mock server did not start: {line}");
        Url = line["SAI_MOCK_URL=".Length..].Trim();
    }

    public async Task<JsonNode?> ControlAsync(string path, JsonNode body)
    {
        using var res = await Http.PostAsync($"{Url}/__mock/{path}", new StringContent(body.ToJsonString(), System.Text.Encoding.UTF8, "application/json"));
        return await res.Content.ReadFromJsonAsync<JsonNode>();
    }

    public ValueTask DisposeAsync()
    {
        Http.Dispose();
        if (_process is { HasExited: false })
        {
            _process.Kill();
            _process.WaitForExit();
        }
        _process?.Dispose();
        return ValueTask.CompletedTask;
    }
}
