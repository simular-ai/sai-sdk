using System.Reflection;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Simular.Sai.Tests;

/// <summary>
/// Parity with surface.json, the contract every language's SDK implements (AGENTS.md).
///
/// Names map mechanically: a snake_case surface name is the PascalCase .NET member, and an
/// <c>Async</c> suffix is dropped (<c>revoke_live</c> is <c>RevokeLiveAsync</c>, <c>resume</c> is
/// <c>Resume</c>). Resources are properties of <see cref="SaiClient"/>. Errors are exceptions:
/// <c>FooError</c> is <c>FooException</c> (<c>SaiError</c> → <c>SaiException</c>,
/// <c>ConnectionError</c> → <c>ConnectionException</c>, <c>LinkOnlyApprovalError</c> →
/// <c>LinkOnlyApprovalException</c>). Event kinds and statuses are the string constants of
/// <see cref="EventKind"/>, <see cref="TurnStatus"/> and <see cref="TurnRecordStatus"/>.
/// </summary>
public class SurfaceTests
{
    private static readonly JsonNode Surface = JsonNode.Parse(File.ReadAllText(Path.Combine(Repo.Root, "surface.json")))!;

    public static string Snake(string pascal) => Regex.Replace(pascal, "(?<=[a-z0-9])([A-Z])", "_$1").ToLowerInvariant();

    public static string Pascal(string snake) =>
        string.Concat(snake.Split('_').Select(p => p.Length == 0 ? p : char.ToUpperInvariant(p[0]) + p[1..]));

    public static string ErrorName(Type t) => t.Name.EndsWith("Exception", StringComparison.Ordinal)
        ? t.Name[..^"Exception".Length] + "Error"
        : t.Name;

    private static List<string> Expected(JsonNode? list) => list!.AsArray().Select(x => x!.GetValue<string>()).Order(StringComparer.Ordinal).ToList();

    private static List<string> PublicMethods(Type t)
    {
        var excluded = t.GetInterfaces().SelectMany(i => t.GetInterfaceMap(i).TargetMethods).ToHashSet();
        return t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
            .Where(m => !m.IsSpecialName && !excluded.Contains(m))
            .Select(m => Snake(m.Name.EndsWith("Async", StringComparison.Ordinal) ? m.Name[..^"Async".Length] : m.Name))
            .Distinct()
            .Order(StringComparer.Ordinal)
            .ToList();
    }

    [Fact]
    public void ClientResources()
    {
        var actual = typeof(SaiClient).GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Select(p => Snake(p.Name)).Order(StringComparer.Ordinal).ToList();
        Assert.Equal(Expected(Surface["resources"]!["client"]), actual);
    }

    public static TheoryData<string> Resources() =>
        new(Surface["resources"]!.AsObject().Select(p => p.Key).Where(k => k != "client"));

    [Theory]
    [MemberData(nameof(Resources))]
    public void ResourceMethods(string resource)
    {
        var property = typeof(SaiClient).GetProperty(Pascal(resource));
        Assert.NotNull(property);
        Assert.Equal(Expected(Surface["resources"]![resource]), PublicMethods(property.PropertyType));
    }

    [Theory]
    [InlineData("Session", typeof(Session))]
    [InlineData("Turn", typeof(Turn))]
    [InlineData("ControlLease", typeof(ControlLease))]
    public void ObjectMethods(string name, Type type)
    {
        Assert.Equal(Expected(Surface["objects"]![name]), PublicMethods(type));
    }

    [Fact]
    public void Errors()
    {
        var exported = typeof(SaiException).Assembly.GetExportedTypes()
            .Where(t => typeof(SaiException).IsAssignableFrom(t))
            .Select(ErrorName)
            .Order(StringComparer.Ordinal)
            .ToList();
        Assert.Equal(Expected(Surface["errors"]), exported);
    }

    [Fact]
    public void ErrorHierarchy()
    {
        Assert.True(typeof(ConflictException).IsAssignableFrom(typeof(LinkOnlyApprovalException)));
        Assert.True(typeof(PermissionDeniedException).IsAssignableFrom(typeof(SpendCapReachedException)));
    }

    [Fact]
    public void EventKindsAndStatuses()
    {
        static List<string> InOrder(JsonNode? list) => list!.AsArray().Select(x => x!.GetValue<string>()).ToList();
        Assert.Equal(InOrder(Surface["event_kinds"]), EventKind.All);
        Assert.Equal(InOrder(Surface["turn_statuses"]), TurnStatus.All);
        Assert.Equal(InOrder(Surface["turn_record_statuses"]), TurnRecordStatus.All);
    }
}
