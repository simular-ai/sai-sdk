using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Simular.Sai;

internal sealed class RequestOptions
{
    public JsonNode? Json { get; init; }
    public IEnumerable<KeyValuePair<string, string?>>? Query { get; init; }
    public byte[]? Body { get; init; }
    public IReadOnlyDictionary<string, string>? Headers { get; init; }
    public TimeSpan? Timeout { get; init; }
}

/// <summary>The one place requests are made: auth header, error mapping, timeouts.</summary>
internal sealed class Http
{
    private readonly HttpClient _client;
    private readonly string _baseUrl;
    private readonly TimeSpan _timeout;
    private readonly string? _versionTag;
    private readonly Func<CancellationToken, ValueTask<string>> _credential;

    public Http(HttpClient client, Func<CancellationToken, ValueTask<string>> credential, string baseUrl, TimeSpan timeout, string? versionTag)
    {
        _client = client;
        _credential = credential;
        _baseUrl = baseUrl.TrimEnd('/');
        _timeout = timeout;
        _versionTag = versionTag;
    }

    public async Task<(int Status, byte[] Body)> RequestAsync(
        HttpMethod method, string path, RequestOptions? opts, CancellationToken cancellationToken)
    {
        opts ??= new RequestOptions();
        var url = new StringBuilder(_baseUrl).Append(path);
        var sep = '?';
        foreach (var (k, v) in opts.Query ?? [])
        {
            if (v is null) continue;
            url.Append(sep).Append(Uri.EscapeDataString(k)).Append('=').Append(Uri.EscapeDataString(v));
            sep = '&';
        }
        var uri = new Uri(url.ToString());
        using var req = new HttpRequestMessage(method, uri);
        req.Headers.TryAddWithoutValidation("User-Agent", $"sai-dotnet/{SaiClient.Version}");
        // routes the request to a tagged API revision
        if (!string.IsNullOrEmpty(_versionTag)) req.Headers.TryAddWithoutValidation("x-sai-version", _versionTag);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await _credential(cancellationToken).ConfigureAwait(false));
        if (opts.Json is not null)
        {
            req.Content = new StringContent(J.Serialize(opts.Json), Encoding.UTF8, "application/json");
        }
        else if (opts.Body is not null)
        {
            req.Content = new ByteArrayContent(opts.Body);
        }
        foreach (var (k, v) in opts.Headers ?? new Dictionary<string, string>())
        {
            if (k.Equals("Content-Type", StringComparison.OrdinalIgnoreCase))
            {
                req.Content ??= new ByteArrayContent([]);
                req.Content.Headers.ContentType = MediaTypeHeaderValue.Parse(v);
            }
            else req.Headers.TryAddWithoutValidation(k, v);
        }

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(opts.Timeout ?? _timeout);
        HttpResponseMessage res;
        byte[] body;
        try
        {
            res = await _client.SendAsync(req, HttpCompletionOption.ResponseContentRead, cts.Token).ConfigureAwait(false);
            body = await res.Content.ReadAsByteArrayAsync(cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException e) when (!cancellationToken.IsCancellationRequested)
        {
            throw new ConnectionException($"Request to {uri.Authority} timed out.", e);
        }
        catch (HttpRequestException e)
        {
            var detail = e.InnerException?.Message ?? e.Message;
            throw new ConnectionException(
                $"Could not reach the Sai API at {uri.Authority}: {detail}. Check the network and SAI_API_URL.", e);
        }
        using (res)
        {
            var status = (int)res.StatusCode;
            if (status >= 400) throw ToError(res, body);
            return (status, body);
        }
    }

    public async Task<JsonElement> JsonAsync(
        HttpMethod method, string path, RequestOptions? opts = null, CancellationToken cancellationToken = default)
    {
        var (_, body) = await RequestAsync(method, path, opts, cancellationToken).ConfigureAwait(false);
        return body.Length == 0 ? default : JsonSerializer.Deserialize<JsonElement>(body);
    }

    private static SaiException ToError(HttpResponseMessage res, byte[] bytes)
    {
        var text = Encoding.UTF8.GetString(bytes);
        JsonElement body;
        try
        {
            var parsed = J.Parse(text);
            body = parsed.ValueKind == JsonValueKind.Object
                ? parsed
                : J.ToElement(new JsonObject { ["error"] = parsed.Str() ?? parsed.GetRawText() });
        }
        catch (JsonException)
        {
            var error = text.Length > 500 ? text[..500] : text;
            if (error.Length == 0) error = res.ReasonPhrase ?? "";
            body = J.ToElement(new JsonObject { ["error"] = error });
        }
        double? retryAfter = null;
        if (res.Headers.TryGetValues("Retry-After", out var values))
        {
            var raw = values.FirstOrDefault();
            if (!string.IsNullOrWhiteSpace(raw) &&
                double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds))
                retryAfter = seconds;
        }
        return SaiException.For((int)res.StatusCode, body, retryAfter);
    }

    /// <summary>JavaScript's <c>encodeURIComponent</c>.</summary>
    public static string Q(string s) => Uri.EscapeDataString(s)
        .Replace("%21", "!").Replace("%27", "'").Replace("%28", "(").Replace("%29", ")").Replace("%2A", "*");
}
