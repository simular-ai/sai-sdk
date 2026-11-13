namespace Simular.Sai;

/// <summary>Options for <see cref="SaiClient"/>.</summary>
public sealed class SaiClientOptions
{
    /// <summary>Defaults to <c>SAI_API_KEY</c>.</summary>
    public string? ApiKey { get; init; }

    /// <summary>Defaults to <c>SAI_API_URL</c>, then <c>https://api.simular.ai</c>.</summary>
    public string? BaseUrl { get; init; }

    /// <summary>Per request. Default 60 seconds.</summary>
    public TimeSpan? Timeout { get; init; }

    /// <summary>Routes requests to a tagged API revision (<c>x-sai-version</c>).</summary>
    public string? VersionTag { get; init; }

    /// <summary>
    /// The Organisation that <c>Tenants.TokenAsync</c>, <c>Tenants.ClientAsync</c> and <c>Usage</c>
    /// act on. Defaults to <c>SAI_ORG_ID</c>. Only an Organisation Key needs it.
    /// </summary>
    public string? OrgId { get; init; }

    /// <summary>The HttpClient to send requests with; the client makes its own when null and disposes it with itself.</summary>
    public HttpClient? HttpClient { get; init; }
}

/// <summary>
/// The Sai API client.
/// <code>
/// using var sai = new SaiClient(); // SAI_API_KEY, and SAI_API_URL if set
/// var session = await sai.Sessions.CreateAsync();
/// Console.WriteLine((await session.RunAsync("Open Notepad and type hello")).Text);
/// </code>
/// </summary>
public sealed class SaiClient : IDisposable
{
    /// <summary>This package's version.</summary>
    public const string Version = "0.2.0";

    internal const string DefaultBaseUrl = "https://api.simular.ai";

    private readonly HttpClient? _ownedClient;

    public SaiClient()
        : this(new SaiClientOptions())
    {
    }

    public SaiClient(SaiClientOptions options)
        : this(options, null, null)
    {
    }

    private SaiClient(SaiClientOptions options, Func<CancellationToken, ValueTask<string>>? credential, HttpClient? shared)
    {
        var key = options.ApiKey ?? Environment.GetEnvironmentVariable("SAI_API_KEY");
        if (credential is null)
        {
            if (string.IsNullOrEmpty(key))
                throw new InvalidOperationException(
                    "No API key: pass ApiKey or set SAI_API_KEY. Create one at https://platform.simular.ai.");
            credential = _ => ValueTask.FromResult(key);
        }
        var client = shared ?? options.HttpClient;
        if (client is null)
        {
            client = _ownedClient = new HttpClient { Timeout = System.Threading.Timeout.InfiniteTimeSpan };
        }
        var baseUrl = options.BaseUrl ?? Environment.GetEnvironmentVariable("SAI_API_URL");
        var http = new Http(
            client, credential, string.IsNullOrEmpty(baseUrl) ? DefaultBaseUrl : baseUrl,
            options.Timeout ?? TimeSpan.FromSeconds(60), options.VersionTag);
        var orgId = options.OrgId ?? Environment.GetEnvironmentVariable("SAI_ORG_ID");
        Machines = new Machines(http);
        Sessions = new Sessions(http, Machines);
        Turns = new Turns(http);
        Learn = new Learn(http);
        Judge = new Judge(http);
        Control = new Control(http);
        Models = new Models(http);
        Files = new Files(http);
        Account = new AccountResource(http);
        Auth = new Auth(http);
        Usage = new UsageResource(http, orgId);
        Tenants = new Tenants(http, orgId, c => new SaiClient(options, c, client));
        TenantMachines = new TenantMachines(http);
    }

    public Machines Machines { get; }

    public Sessions Sessions { get; }

    public Turns Turns { get; }

    /// <summary>Recorded turns → Simulang code, and code repair (research preview).</summary>
    public Learn Learn { get; }

    /// <summary>Judge recorded turns against new criteria (research preview).</summary>
    public Judge Judge { get; }

    public Control Control { get; }

    public Models Models { get; }

    public Files Files { get; }

    public AccountResource Account { get; }

    /// <summary>Who the key acts as.</summary>
    public Auth Auth { get; }

    /// <summary>What an Organisation is charged, per Tenant and per session. Takes an Organisation Key.</summary>
    public UsageResource Usage { get; }

    /// <summary>Your customers under an Organisation. Takes an Organisation Key.</summary>
    public Tenants Tenants { get; }

    /// <summary>A Tenant's computers: enrolled, and cloud machines Sai hosts. Takes an Organisation Key.</summary>
    public TenantMachines TenantMachines { get; }

    public void Dispose() => _ownedClient?.Dispose();
}

public sealed class Models
{
    private readonly Http _http;

    internal Models(Http http) => _http = http;

    /// <summary>Models a session can run on; <c>Allowed</c> says whether this plan may use each.</summary>
    public async Task<IReadOnlyList<Model>> ListAsync(CancellationToken cancellationToken = default)
    {
        var d = await _http.JsonAsync(HttpMethod.Get, "/v1/agents/models", null, cancellationToken).ConfigureAwait(false);
        return d.Arr("models").Select(Model.Parse).ToList();
    }
}

public sealed class Files
{
    private readonly Http _http;

    internal Files(Http http) => _http = http;

    /// <summary>Upload one file (max 25 MB) from disk to attach to a message. <paramref name="name"/> defaults to the file's name.</summary>
    public async Task<Attachment> UploadAsync(string path, string? name = null, CancellationToken cancellationToken = default) =>
        await UploadAsync(await File.ReadAllBytesAsync(path, cancellationToken).ConfigureAwait(false), name ?? Path.GetFileName(path),
            cancellationToken).ConfigureAwait(false);

    /// <summary>Upload bytes as a file named <paramref name="name"/>; the server derives the MIME type from the name.</summary>
    public async Task<Attachment> UploadAsync(byte[] data, string name, CancellationToken cancellationToken = default) =>
        Attachment.Parse(await _http.JsonAsync(HttpMethod.Post, "/v1/agents/upload", new RequestOptions
        {
            Body = data,
            // The server reads only a body that has a Content-Type.
            Headers = new Dictionary<string, string> { ["Content-Type"] = "application/octet-stream", ["x-filename"] = Http.Q(name) },
            Timeout = TimeSpan.FromSeconds(120),
        }, cancellationToken).ConfigureAwait(false));
}

public sealed class AccountResource
{
    private readonly Http _http;

    internal AccountResource(Http http) => _http = http;

    /// <summary>Plan and spendable credit. Slow-ish (billing lookup): not for a poll loop.</summary>
    public async Task<Account> GetAsync(CancellationToken cancellationToken = default) =>
        Account.Parse(await _http.JsonAsync(HttpMethod.Get, "/v1/agents/account", null, cancellationToken).ConfigureAwait(false));
}

public sealed class Auth
{
    private readonly Http _http;

    internal Auth(Http http) => _http = http;

    /// <summary>Who the key or token acts as. Throws <see cref="AuthenticationException"/> for a missing or revoked key.</summary>
    public async Task<AuthInfo> CheckAsync(CancellationToken cancellationToken = default) =>
        AuthInfo.Parse(await _http.JsonAsync(HttpMethod.Get, "/v1/agents/auth", null, cancellationToken).ConfigureAwait(false));
}

public sealed class UsageResource
{
    private readonly Http _http;
    private readonly string? _orgId;

    internal UsageResource(Http http, string? orgId)
    {
        _http = http;
        _orgId = orgId;
    }

    /// <summary>
    /// What the Organisation is charged, in total and per Tenant, per <paramref name="granularity"/>
    /// (<c>hour</c>, <c>day</c> or <c>month</c>; default <c>day</c>) from <paramref name="from"/> to
    /// <paramref name="to"/>: <c>2026-10</c>, <c>2026-10-15</c> or <c>2026-10-15T09</c>. Each defaults
    /// to a range that ends now.
    /// </summary>
    public async Task<OrgUsage> GetAsync(
        string? granularity = null, string? from = null, string? to = null, string? orgId = null,
        CancellationToken cancellationToken = default) =>
        OrgUsage.Parse(await _http.JsonAsync(HttpMethod.Get, $"/v1/orgs/{Http.Q(Org(orgId))}/usage", new RequestOptions
        {
            Query = [new("granularity", granularity), new("from", from), new("to", to)],
        }, cancellationToken).ConfigureAwait(false));

    /// <summary>
    /// One page of what each of a Tenant's sessions spent on AI calls, oldest first, for the UTC days
    /// <paramref name="from"/> to <paramref name="to"/> (<c>YYYY-MM-DD</c>, both included, at most 93
    /// days). Keep paging with <c>NextCursor</c> until it is null: a page can be empty and not be the last.
    /// <para>
    /// With <paramref name="sessionIds"/> (1 to 50) instead of the range, the named sessions' spend right
    /// now, each with <c>Settled</c>, and the page's <c>AsOf</c>; no paging. Charge for a task once its
    /// session is settled.
    /// </para>
    /// </summary>
    public async Task<SessionSpendPage> SessionsAsync(
        TenantRef tenant, string? from = null, string? to = null, int? limit = null, string? cursor = null,
        IEnumerable<string>? sessionIds = null, string? orgId = null,
        CancellationToken cancellationToken = default)
    {
        var ids = sessionIds?.ToList();
        return SessionSpendPage.Parse(await _http.JsonAsync(HttpMethod.Get, $"/v1/orgs/{Http.Q(Org(orgId))}/usage/sessions", new RequestOptions
        {
            Query =
            [
                new("tenantId", tenant.Id), new("from", from), new("to", to), new("limit", limit?.ToString()), new("cursor", cursor),
                new("sessionIds", ids is { Count: > 0 } ? string.Join(",", ids) : null),
            ],
        }, cancellationToken).ConfigureAwait(false));
    }

    private string Org(string? orgId)
    {
        var id = orgId ?? _orgId;
        return string.IsNullOrEmpty(id)
            ? throw new InvalidOperationException("No Organisation id: pass orgId here or to new SaiClient(), or set SAI_ORG_ID.")
            : id;
    }
}
