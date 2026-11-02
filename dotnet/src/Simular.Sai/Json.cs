using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Simular.Sai;

/// <summary>Reading the API's JSON loosely, the way the TypeScript SDK does, and writing it.</summary>
internal static class J
{
    public static readonly JsonSerializerOptions Options = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public static readonly JsonElement EmptyObject = Parse("{}");

    public static JsonElement Parse(string text) => JsonSerializer.Deserialize<JsonElement>(text);

    public static JsonElement Get(this JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) ? v : default;

    public static bool Has(this JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out _);

    public static string? Str(this JsonElement e) => e.ValueKind == JsonValueKind.String ? e.GetString() : null;

    public static string? Str(this JsonElement e, string name) => e.Get(name).Str();

    public static double? Num(this JsonElement e) => e.ValueKind == JsonValueKind.Number ? e.GetDouble() : null;

    public static double? Num(this JsonElement e, string name) => e.Get(name).Num();

    public static long? Long(this JsonElement e, string name)
    {
        var v = e.Get(name);
        if (v.ValueKind != JsonValueKind.Number) return null;
        return v.TryGetInt64(out var l) ? l : (long)v.GetDouble();
    }

    public static int? Int(this JsonElement e, string name) => (int?)e.Long(name);

    public static bool? BoolOrNull(this JsonElement e, string name)
    {
        var v = e.Get(name);
        return v.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null,
        };
    }

    /// <summary>JavaScript's <c>Boolean(v)</c>.</summary>
    public static bool Truthy(this JsonElement v) => v.ValueKind switch
    {
        JsonValueKind.True or JsonValueKind.Object or JsonValueKind.Array => true,
        JsonValueKind.String => v.GetString()!.Length > 0,
        JsonValueKind.Number => v.GetDouble() is var d && d != 0 && !double.IsNaN(d),
        _ => false,
    };

    public static bool Truthy(this JsonElement e, string name) => e.Get(name).Truthy();

    public static bool IsObject(this JsonElement e) => e.ValueKind == JsonValueKind.Object;

    public static JsonElement Obj(this JsonElement e, string name)
    {
        var v = e.Get(name);
        return v.ValueKind == JsonValueKind.Object ? v : EmptyObject;
    }

    public static IEnumerable<JsonElement> Arr(this JsonElement e, string name)
    {
        var v = e.Get(name);
        return v.ValueKind == JsonValueKind.Array ? v.EnumerateArray() : [];
    }

    public static IReadOnlyList<string> Strings(this JsonElement e, string name) =>
        e.Arr(name).Select(x => x.Str() ?? x.GetRawText()).ToList();

    /// <summary>Free-form JSON: null when missing or null.</summary>
    public static JsonElement? Opaque(this JsonElement e, string name)
    {
        var v = e.Get(name);
        return v.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null ? null : v;
    }

    /// <summary>A value as JSON: a JsonNode or JsonElement as is, anything else through System.Text.Json.</summary>
    public static JsonNode? ToNode(object? value) => value switch
    {
        null => null,
        JsonNode n => n.DeepClone(),
        JsonElement e => JsonSerializer.SerializeToNode(e, Options),
        _ => JsonSerializer.SerializeToNode(value, value.GetType(), Options),
    };

    public static JsonElement ToElement(JsonNode? node) =>
        node is null ? Parse("null") : JsonSerializer.SerializeToElement(node, Options);

    public static string Serialize(JsonNode? node) => node is null ? "null" : node.ToJsonString(Options);

    /// <summary>
    /// <paramref name="node"/> as JavaScript's <c>JSON.stringify</c> writes it, byte for byte, so the
    /// Simulang every SDK sends is the same.
    /// </summary>
    public static string Stringify(JsonNode? node)
    {
        var sb = new StringBuilder();
        Write(sb, node);
        return sb.ToString();
    }

    private static void Write(StringBuilder sb, JsonNode? node)
    {
        switch (node)
        {
            case null:
                sb.Append("null");
                return;
            case JsonObject o:
                sb.Append('{');
                var first = true;
                foreach (var (k, v) in o)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    Quote(sb, k);
                    sb.Append(':');
                    Write(sb, v);
                }
                sb.Append('}');
                return;
            case JsonArray a:
                sb.Append('[');
                for (var i = 0; i < a.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    Write(sb, a[i]);
                }
                sb.Append(']');
                return;
        }
        switch (node.GetValueKind())
        {
            case JsonValueKind.String:
                Quote(sb, node.GetValue<string>());
                return;
            case JsonValueKind.True:
                sb.Append("true");
                return;
            case JsonValueKind.False:
                sb.Append("false");
                return;
            case JsonValueKind.Number:
                sb.Append(JsNumber(double.Parse(node.ToJsonString(), CultureInfo.InvariantCulture)));
                return;
            default:
                sb.Append("null");
                return;
        }
    }

    private static void Quote(StringBuilder sb, string s)
    {
        sb.Append('"');
        for (var i = 0; i < s.Length; i++)
        {
            var c = s[i];
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]))
                    {
                        sb.Append(c).Append(s[i + 1]);
                        i++;
                    }
                    else if (char.IsSurrogate(c))
                        sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
    }

    /// <summary>JavaScript's <c>Number.prototype.toString()</c>.</summary>
    internal static string JsNumber(double x)
    {
        if (double.IsNaN(x) || double.IsInfinity(x)) return "null";
        if (x == 0) return "0";
        var r = x.ToString("R", CultureInfo.InvariantCulture);
        var negative = r.StartsWith('-');
        if (negative) r = r[1..];
        var exp = 0;
        var e = r.IndexOfAny(['E', 'e']);
        if (e >= 0)
        {
            exp = int.Parse(r[(e + 1)..], CultureInfo.InvariantCulture);
            r = r[..e];
        }
        var dot = r.IndexOf('.');
        var intPart = dot >= 0 ? r[..dot] : r;
        var fracPart = dot >= 0 ? r[(dot + 1)..] : "";
        var digits = (intPart + fracPart).TrimStart('0');
        var leadingZeros = (intPart + fracPart).Length - digits.Length;
        // value = 0.<digits> × 10^n
        var n = intPart.Length + exp - leadingZeros;
        digits = digits.TrimEnd('0');
        var k = digits.Length;
        string s;
        if (k <= n && n <= 21) s = digits + new string('0', n - k);
        else if (0 < n && n <= 21) s = digits[..n] + "." + digits[n..];
        else if (-6 < n && n <= 0) s = "0." + new string('0', -n) + digits;
        else
        {
            var p = n - 1;
            s = digits[..1] + (k > 1 ? "." + digits[1..] : "") + "e" + (p >= 0 ? "+" : "-") + Math.Abs(p);
        }
        return negative ? "-" + s : s;
    }
}
