using System.Text.Json.Nodes;

namespace Simular.Sai;

/// <summary>
/// What <see cref="Tenants.UpdateAsync"/> changes; what is left unset is not sent. Setting
/// <see cref="CloudMachineLimit"/> to null removes the cap.
/// </summary>
public sealed class TenantUpdate
{
    private readonly long? _cloudMachineLimit;

    public string? Name { get; init; }

    /// <summary>Replaces the whole map.</summary>
    public IReadOnlyDictionary<string, string>? Metadata { get; init; }

    /// <summary><c>disabled</c> stops the Tenant's tokens and machines; <c>active</c> brings it back.</summary>
    public string? Status { get; init; }

    /// <summary>
    /// Caps the Tenant's cloud machines (0 to 1000); null removes the cap. Lowering it deletes
    /// nothing: creates are refused until the count fits.
    /// </summary>
    public long? CloudMachineLimit
    {
        get => _cloudMachineLimit;
        init
        {
            _cloudMachineLimit = value;
            CloudMachineLimitSet = true;
        }
    }

    /// <summary>The Tenant's residential proxy switch. It has no effect yet: traffic goes direct.</summary>
    public bool? ResidentialProxy { get; init; }

    /// <summary>
    /// Lets the Tenant's learn jobs and direct control run code on its enrolled machines (default off).
    /// </summary>
    public bool? OwnComputerAccess { get; init; }

    internal bool CloudMachineLimitSet { get; private init; }
}

/// <summary>Your customers, under an Organisation. Every call takes an Organisation Key.</summary>
public sealed class Tenants
{
    /// <summary><see cref="ClientAsync"/> exchanges again when its token has less than this left.</summary>
    internal static readonly TimeSpan TokenRefreshMargin = TimeSpan.FromMinutes(5);

    private readonly Http _http;
    private readonly string? _orgId;
    private readonly Func<Func<CancellationToken, ValueTask<string>>, SaiClient> _withCredential;

    internal Tenants(Http http, string? orgId, Func<Func<CancellationToken, ValueTask<string>>, SaiClient> withCredential)
    {
        _http = http;
        _orgId = orgId;
        _withCredential = withCredential;
    }

    internal static string PathOf(TenantRef tenant) => $"/v1/tenants/{Http.Q(tenant.Id)}";

    /// <summary><paramref name="externalId"/> is your id for the customer, unique in the Organisation, and cannot change later.</summary>
    public async Task<Tenant> CreateAsync(
        string name, string? externalId = null, IReadOnlyDictionary<string, string>? metadata = null,
        CancellationToken cancellationToken = default)
    {
        var body = new JsonObject { ["name"] = name };
        if (externalId is not null) body["externalId"] = externalId;
        if (metadata is not null) body["metadata"] = J.ToNode(metadata);
        return Tenant.Parse(await _http.JsonAsync(HttpMethod.Post, "/v1/tenants", new RequestOptions { Json = body }, cancellationToken)
            .ConfigureAwait(false));
    }

    /// <summary>
    /// One page, newest first. <paramref name="externalId"/> finds the Tenant with that id (zero or
    /// one) and cannot be combined with <paramref name="status"/>.
    /// </summary>
    public async Task<TenantPage> ListAsync(
        string? status = null, string? externalId = null, int? limit = null, string? cursor = null,
        CancellationToken cancellationToken = default)
    {
        var d = await _http.JsonAsync(HttpMethod.Get, "/v1/tenants", new RequestOptions
        {
            Query = [new("status", status), new("externalId", externalId), new("limit", limit?.ToString()), new("cursor", cursor)],
        }, cancellationToken).ConfigureAwait(false);
        return new TenantPage(d.Arr("tenants").Select(Tenant.Parse).ToList(), d.Str("nextCursor"));
    }

    public async Task<Tenant> GetAsync(TenantRef tenant, CancellationToken cancellationToken = default) =>
        Tenant.Parse(await _http.JsonAsync(HttpMethod.Get, PathOf(tenant), null, cancellationToken).ConfigureAwait(false));

    /// <summary>
    /// Change a Tenant. Only the Organisation Key or an owner may set <c>CloudMachineLimit</c>,
    /// <c>ResidentialProxy</c> and <c>OwnComputerAccess</c>.
    /// </summary>
    public async Task<Tenant> UpdateAsync(TenantRef tenant, TenantUpdate update, CancellationToken cancellationToken = default)
    {
        var body = new JsonObject();
        if (update.Name is not null) body["name"] = update.Name;
        if (update.Metadata is not null) body["metadata"] = J.ToNode(update.Metadata);
        if (update.Status is not null) body["status"] = update.Status;
        if (update.CloudMachineLimitSet) body["cloudMachineLimit"] = update.CloudMachineLimit;
        if (update.ResidentialProxy is { } rp) body["residentialProxy"] = rp;
        if (update.OwnComputerAccess is { } oca) body["ownComputerAccess"] = oca;
        return Tenant.Parse(await _http.JsonAsync(HttpMethod.Patch, PathOf(tenant), new RequestOptions { Json = body }, cancellationToken)
            .ConfigureAwait(false));
    }

    /// <summary>
    /// Disables the Tenant and revokes every enrolled machine. Cloud machines stay and hibernate:
    /// delete them with <c>TenantMachines.DeleteAsync</c>. Its data is kept.
    /// </summary>
    public async Task DeleteAsync(TenantRef tenant, CancellationToken cancellationToken = default) =>
        await _http.RequestAsync(HttpMethod.Delete, PathOf(tenant), null, cancellationToken).ConfigureAwait(false);

    /// <summary>A single-use code that enrolls one computer into the Tenant. It expires in 15 minutes.</summary>
    public async Task<Enrollment> CreateEnrollmentAsync(TenantRef tenant, CancellationToken cancellationToken = default) =>
        Enrollment.Parse(await _http.JsonAsync(HttpMethod.Post, $"{PathOf(tenant)}/enrollments", null, cancellationToken)
            .ConfigureAwait(false));

    /// <summary>
    /// Exchange the Organisation Key for a one-hour token that acts as the Tenant.
    /// <paramref name="orgId"/> defaults to the client's <c>OrgId</c> (<c>SAI_ORG_ID</c>).
    /// </summary>
    public async Task<TenantToken> TokenAsync(TenantRef tenant, string? orgId = null, CancellationToken cancellationToken = default)
    {
        var org = orgId ?? _orgId;
        if (string.IsNullOrEmpty(org))
            throw new InvalidOperationException("No Organisation id: pass orgId here or to new SaiClient(), or set SAI_ORG_ID.");
        return TenantToken.Parse(await _http.JsonAsync(HttpMethod.Post, $"/v1/orgs/{Http.Q(org)}/tenants/{Http.Q(tenant.Id)}/token",
            null, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>
    /// A client that acts as the Tenant. It exchanges a token now, and again before a request when
    /// the token has less than five minutes left. Uses this client's Organisation Key.
    /// </summary>
    public async Task<SaiClient> ClientAsync(TenantRef tenant, string? orgId = null, CancellationToken cancellationToken = default)
    {
        var current = await TokenAsync(tenant, orgId, cancellationToken).ConfigureAwait(false);
        var gate = new SemaphoreSlim(1, 1);
        return _withCredential(async ct =>
        {
            await gate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                if (current.ExpiresAt - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() < TokenRefreshMargin.TotalMilliseconds)
                    current = await TokenAsync(tenant, orgId, ct).ConfigureAwait(false);
                return current.Token;
            }
            finally
            {
                gate.Release();
            }
        });
    }
}

/// <summary>A Tenant's computers, enrolled and cloud. Every call takes an Organisation Key.</summary>
public sealed class TenantMachines
{
    /// <summary>Between machine reads while <c>CreateAsync(wait: true)</c> waits.</summary>
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(5);

    private readonly Http _http;

    internal TenantMachines(Http http) => _http = http;

    /// <summary>
    /// Create a cloud machine for the Tenant. <paramref name="os"/> is <c>windows</c> or <c>linux</c>;
    /// the size follows it. <paramref name="requestId"/> makes a retry safe: the same id and body
    /// return the first machine. Returns at once with <c>State == "provisioning"</c>;
    /// <paramref name="wait"/> reads the machine every 5 s until it is <c>ready</c>, throws
    /// <see cref="SaiException"/> if it fails or is deleted, and <see cref="TimeoutException"/> after
    /// <paramref name="timeout"/> (default 10 minutes).
    /// </summary>
    public async Task<TenantMachine> CreateAsync(
        TenantRef tenant, string os, string? name = null, string? requestId = null, bool wait = false, TimeSpan? timeout = null,
        CancellationToken cancellationToken = default)
    {
        var body = new JsonObject { ["os"] = os };
        if (name is not null) body["name"] = name;
        if (requestId is not null) body["requestId"] = requestId;
        var machine = TenantMachine.Parse(await _http.JsonAsync(HttpMethod.Post, $"{Tenants.PathOf(tenant)}/machines",
            new RequestOptions { Json = body }, cancellationToken).ConfigureAwait(false));
        if (!wait) return machine;
        var deadline = DateTimeOffset.UtcNow + (timeout ?? TimeSpan.FromMinutes(10));
        while (machine.State != "ready")
        {
            if (machine.State is "failed" or "deleting")
                throw new SaiException($"Cloud machine {machine.Id} is {machine.State} and will not become ready.", body: machine.Raw);
            if (DateTimeOffset.UtcNow + PollInterval > deadline)
                throw new TimeoutException($"Cloud machine {machine.Id} still {machine.State}.");
            await Task.Delay(PollInterval, cancellationToken).ConfigureAwait(false);
            try
            {
                machine = await GetAsync(tenant, machine.Id, cancellationToken).ConfigureAwait(false);
            }
            catch (RateLimitException e)
            {
                await Task.Delay(TimeSpan.FromSeconds(e.RetryAfter ?? 30), cancellationToken).ConfigureAwait(false);
            }
        }
        return machine;
    }

    /// <summary>Both kinds, enrolled and cloud. A cloud machine is listed from the moment it is created.</summary>
    public async Task<IReadOnlyList<TenantMachine>> ListAsync(TenantRef tenant, CancellationToken cancellationToken = default)
    {
        var d = await _http.JsonAsync(HttpMethod.Get, $"{Tenants.PathOf(tenant)}/machines", null, cancellationToken).ConfigureAwait(false);
        return d.Arr("machines").Select(TenantMachine.Parse).ToList();
    }

    public async Task<TenantMachine> GetAsync(TenantRef tenant, string machineId, CancellationToken cancellationToken = default) =>
        TenantMachine.Parse(await _http.JsonAsync(HttpMethod.Get, $"{Tenants.PathOf(tenant)}/machines/{Http.Q(machineId)}", null,
            cancellationToken).ConfigureAwait(false));

    /// <summary>
    /// An enrolled machine is signed out at once (<c>revoked</c>). A cloud machine is deleted with its
    /// disk (<c>deleting</c>), which cannot be undone.
    /// </summary>
    public async Task<string> DeleteAsync(TenantRef tenant, TenantMachineRef machine, CancellationToken cancellationToken = default)
    {
        var (status, _) = await _http.RequestAsync(HttpMethod.Delete, $"{Tenants.PathOf(tenant)}/machines/{Http.Q(machine.Id)}", null,
            cancellationToken).ConfigureAwait(false);
        return status == 202 ? "deleting" : "revoked";
    }

    /// <summary><see cref="DeleteAsync"/> without its answer. On a cloud machine it deletes the machine.</summary>
    public async Task RevokeAsync(TenantRef tenant, TenantMachineRef machine, CancellationToken cancellationToken = default) =>
        await DeleteAsync(tenant, machine, cancellationToken).ConfigureAwait(false);
}
