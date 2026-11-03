using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Simular.Sai.Tests;

/// <summary>One C# block of the docs, from <c>node conformance/snippets.mjs --lang csharp</c>.</summary>
public sealed record Snippet(int Index, string File, int Line, string Context, string Code)
{
    public override string ToString() => $"{File}:{Line}";
}

/// <summary>
/// Every C# block in the docs (sai-platform) as one console project: each block a static method in a
/// class of its own, and a <c>Main</c> that runs the block named by its argument. Built once.
/// </summary>
public sealed partial class SnippetProgram : IAsyncLifetime
{
    private static readonly string? DocsError;

    public static IReadOnlyList<Snippet> Snippets { get; } = Load(out DocsError);

    public MockServer Server { get; } = new();

    public string WorkDir { get; } = Directory.CreateTempSubdirectory("sai-dotnet-snippets-").FullName;

    public string Dll => Path.Combine(WorkDir, "build", "bin", "Snippets.dll");

    /// <summary>The build's diagnostics, by snippet index, mapped to the docs' files and lines.</summary>
    public Dictionary<int, List<string>> Diagnostics { get; } = [];

    public string BuildOutput { get; private set; } = "";

    public static bool Required => Environment.GetEnvironmentVariable("SAI_DOCS_REQUIRED") == "1";

    public static string? Missing => DocsError;

    // generated line → docs location, by snippet
    private readonly Dictionary<int, Dictionary<int, string>> _lines = [];

    private static List<Snippet> Load(out string? error)
    {
        var psi = Repo.Node(Path.Combine(Repo.Conformance, "snippets.mjs"), "--lang", "csharp");
        using var p = Process.Start(psi)!;
        var stdout = p.StandardOutput.ReadToEndAsync();
        var stderr = p.StandardError.ReadToEnd();
        p.WaitForExit();
        if (p.ExitCode != 0)
        {
            error = stderr.Trim();
            return [];
        }
        error = null;
        var i = 0;
        return JsonDocument.Parse(stdout.Result).RootElement.EnumerateArray()
            .Select(s => new Snippet(
                i++, s.GetProperty("file").GetString()!, s.GetProperty("line").GetInt32(),
                s.GetProperty("context").GetString()!, s.GetProperty("code").GetString()!))
            .ToList();
    }

    public async ValueTask InitializeAsync()
    {
        await Server.InitializeAsync();
        if (Snippets.Count == 0) return;
        CopyDirectory(Path.Combine(Repo.Conformance, "fixtures"), WorkDir);
        var src = Path.Combine(WorkDir, "build");
        Directory.CreateDirectory(src);
        // Stops MSBuild from picking up a Directory.Build.props above the temp directory.
        File.WriteAllText(Path.Combine(src, "Directory.Build.props"), "<Project />");
        File.WriteAllText(Path.Combine(src, "Directory.Build.targets"), "<Project />");
        File.WriteAllText(Path.Combine(src, "Snippets.csproj"), $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>Exe</OutputType>
                <TargetFramework>net10.0</TargetFramework>
                <ImplicitUsings>enable</ImplicitUsings>
                <Nullable>enable</Nullable>
                <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
                <OutputPath>bin/</OutputPath>
                <AppendTargetFrameworkToOutputPath>false</AppendTargetFrameworkToOutputPath>
              </PropertyGroup>
              <ItemGroup>
                <Reference Include="Simular.Sai">
                  <HintPath>{typeof(SaiClient).Assembly.Location}</HintPath>
                </Reference>
              </ItemGroup>
            </Project>
            """);
        foreach (var s in Snippets) File.WriteAllText(Path.Combine(src, $"S{s.Index}.cs"), Generate(s));
        await BuildAsync(src, Snippets);
        if (Diagnostics.Count > 0)
        {
            // Build the rest without the blocks that do not compile, so each of those fails alone.
            foreach (var i in Diagnostics.Keys) File.Delete(Path.Combine(src, $"S{i}.cs"));
            var (code, output) = await BuildAsync(src, Snippets.Where(s => !Diagnostics.ContainsKey(s.Index)));
            if (code != 0) throw new InvalidOperationException("dotnet build failed:\n" + output);
        }
    }

    private async Task<(int, string)> BuildAsync(string src, IEnumerable<Snippet> snippets)
    {
        var main = new StringBuilder("internal static class Program\n{\n    public static async Task Main(string[] args)\n    {\n        switch (args[0])\n        {\n");
        foreach (var s in snippets) main.Append($"            case \"{s.Index}\": await S{s.Index}.Run(); break;\n");
        main.Append("        }\n    }\n}\n");
        File.WriteAllText(Path.Combine(src, "Program.cs"), main.ToString());
        var (code, output) = await DotnetAsync(src, "build", "-nologo", "-v:q", "-nodeReuse:false", "-clp:NoSummary");
        BuildOutput = output;
        foreach (Match m in DiagnosticLine().Matches(output))
        {
            var index = int.Parse(m.Groups["n"].Value);
            var line = int.Parse(m.Groups["line"].Value);
            var where = _lines.GetValueOrDefault(index)?.GetValueOrDefault(line) ?? $"S{index}.cs:{line}";
            var list = Diagnostics.TryGetValue(index, out var l) ? l : Diagnostics[index] = [];
            var text = $"{where}: {m.Groups["text"].Value.Trim()}";
            if (!list.Contains(text)) list.Add(text);
        }
        if (code != 0 && Diagnostics.Count == 0) throw new InvalidOperationException("dotnet build failed:\n" + output);
        return (code, output);
    }

    [GeneratedRegex(@"S(?<n>\d+)\.cs\((?<line>\d+),\d+\): (?<text>(error|warning) [^\[\r\n]*)")]
    private static partial Regex DiagnosticLine();

    [GeneratedRegex(@"^using\s+(static\s+)?[A-Za-z_][\w.]*(\s*=\s*[^;]+)?;\s*$")]
    private static partial Regex UsingDirective();

    /// <summary>The block as a class: usings first, then the context, then the block in a scope of its own.</summary>
    private string Generate(Snippet s)
    {
        var map = _lines[s.Index] = [];
        var sb = new StringBuilder();
        var n = 0;
        void Emit(string text, string? where = null)
        {
            sb.Append(text).Append('\n');
            n++;
            if (where is not null) map[n] = where;
        }
        var usings = $"{s.Context}\n{s.Code}".Split('\n').Where(l => UsingDirective().IsMatch(l)).Distinct().ToList();
        foreach (var u in usings) Emit(u);
        // A block need not await anything.
        Emit("#pragma warning disable CS1998");
        Emit($"internal static class S{s.Index}");
        Emit("{");
        Emit("    public static async Task Run()");
        Emit("    {");
        void Body(string code, int line, string file)
        {
            var lines = code.Split('\n');
            for (var i = 0; i < lines.Length; i++)
                if (!UsingDirective().IsMatch(lines[i])) Emit(lines[i], $"{file}:{line + 1 + i}");
        }
        if (s.Context.Length > 0)
        {
            var ctx = Snippets.LastOrDefault(x => x.File == s.File && x.Code == s.Context && x.Index < s.Index);
            Body(s.Context, ctx?.Line ?? 0, s.File);
            Emit("{");
            Body(s.Code, s.Line, s.File);
            Emit("}");
        }
        else Body(s.Code, s.Line, s.File);
        Emit("    }");
        Emit("}");
        return sb.ToString();
    }

    public static ProcessStartInfo Dotnet(string cwd, params string[] args)
    {
        var host = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH");
        var psi = new ProcessStartInfo(string.IsNullOrEmpty(host) ? "dotnet" : host)
        {
            WorkingDirectory = cwd,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        // The test host's MSBuild settings must not leak into a nested build.
        foreach (var k in psi.Environment.Keys.Where(k => k.StartsWith("MSBuild", StringComparison.OrdinalIgnoreCase)).ToList())
            psi.Environment.Remove(k);
        return psi;
    }

    private static async Task<(int, string)> DotnetAsync(string cwd, params string[] args)
    {
        using var p = Process.Start(Dotnet(cwd, args))!;
        var stdout = p.StandardOutput.ReadToEndAsync();
        var stderr = p.StandardError.ReadToEndAsync();
        await p.WaitForExitAsync();
        return (p.ExitCode, await stdout + await stderr);
    }

    private static void CopyDirectory(string from, string to)
    {
        foreach (var f in Directory.GetFiles(from, "*", SearchOption.AllDirectories))
        {
            var dest = Path.Combine(to, Path.GetRelativePath(from, f));
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            File.Copy(f, dest, true);
        }
    }

    public async ValueTask DisposeAsync()
    {
        await Server.DisposeAsync();
        try
        {
            Directory.Delete(WorkDir, true);
        }
        catch (IOException)
        {
        }
    }
}

/// <summary>
/// Every C# block in the docs (sai-platform) runs against the mock server's fake API. See
/// ../../conformance/README.md#docs-snippets. The docs are read from <c>SAI_DOCS_DIR</c>, by default
/// <c>../sai-platform/src/docs/content</c>; without them these tests are skipped unless
/// <c>SAI_DOCS_REQUIRED=1</c>.
/// </summary>
public class SnippetTests(SnippetProgram program) : IClassFixture<SnippetProgram>
{
    [Fact]
    public void FindsTheDocs()
    {
        if (SnippetProgram.Missing is { } why)
        {
            Assert.False(SnippetProgram.Required, why);
            Assert.Skip(why);
        }
    }

    public static TheoryData<string> Names() =>
        SnippetProgram.Snippets.Count == 0 ? new("(no docs)") : new(SnippetProgram.Snippets.Select(s => s.ToString()));

    [Theory(Timeout = 120_000)]
    [MemberData(nameof(Names))]
    public async Task Snippet(string name)
    {
        var s = SnippetProgram.Snippets.FirstOrDefault(x => x.ToString() == name);
        if (s is null)
        {
            var why = SnippetProgram.Missing ?? "no C# blocks in the docs";
            Assert.False(SnippetProgram.Required, why);
            Assert.Skip(why);
            return;
        }
        if (program.Diagnostics.TryGetValue(s.Index, out var problems))
            Assert.Fail(string.Join('\n', problems));
        if (!File.Exists(program.Dll)) Assert.Fail("the snippets did not build:\n" + program.BuildOutput);

        var ct = TestContext.Current.CancellationToken;
        await program.Server.Http.PostAsync($"{program.Server.Url}/__mock/reset", null, ct);
        var psi = SnippetProgram.Dotnet(program.WorkDir, program.Dll, s.Index.ToString());
        psi.Environment["SAI_API_KEY"] = "sapi_docs";
        psi.Environment["SAI_ORG_KEY"] = "sapi_docs_org";
        psi.Environment["SAI_API_URL"] = program.Server.Url;
        psi.Environment["SAI_ORG_ID"] = "org_docs";
        using var p = Process.Start(psi)!;
        var stdout = p.StandardOutput.ReadToEndAsync(ct);
        var stderr = p.StandardError.ReadToEndAsync(ct);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(60));
        try
        {
            await p.WaitForExitAsync(cts.Token);
        }
        catch (OperationCanceledException)
        {
            p.Kill(true);
            Assert.Fail($"{name} did not finish in 60 s");
        }
        Assert.True(p.ExitCode == 0, $"{name} exited {p.ExitCode}:\n{await stderr}\n{await stdout}");
    }
}
