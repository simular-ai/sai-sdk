namespace Simular.Sai;

/// <summary>The computers Sai works on: cloud computers, or the customer's own PC with the Sai app.</summary>
public sealed class Machines
{
    private readonly Http _http;

    internal Machines(Http http) => _http = http;

    public async Task<IReadOnlyList<Machine>> ListAsync(CancellationToken cancellationToken = default)
    {
        var d = await _http.JsonAsync(HttpMethod.Get, "/v1/agents/machines", null, cancellationToken).ConfigureAwait(false);
        return d.Arr("machines").Select(Machine.Parse).ToList();
    }

    /// <summary>One machine from <see cref="ListAsync"/>; <see cref="NotFoundException"/> when the account has none with that id.</summary>
    public async Task<Machine> GetAsync(string machineId, CancellationToken cancellationToken = default)
    {
        var machines = await ListAsync(cancellationToken).ConfigureAwait(false);
        return machines.FirstOrDefault(m => m.Id == machineId)
            ?? throw new NotFoundException($"Machine {machineId} not found on this account.");
    }

    /// <summary>
    /// The live screen: <c>LiveUrl</c>, a page a person can open without a Simular sign-in, and a
    /// Guacamole tunnel for a viewer of your own. The machine must be running.
    /// </summary>
    public async Task<LiveView> LiveAsync(MachineRef machine, CancellationToken cancellationToken = default)
    {
        var d = await _http.JsonAsync(HttpMethod.Post, $"/v1/agents/machines/{Http.Q(machine.Id)}/live", null, cancellationToken)
            .ConfigureAwait(false);
        return new LiveView(
            d.Str("machineId") ?? machine.Id, d.Str("liveUrl"), d.Long("expiresAt"), d.Str("websocketUrl") ?? "",
            d.Int("width") ?? 0, d.Int("height") ?? 0);
    }

    /// <summary>
    /// Revokes every <c>LiveUrl</c> handed out for the machine; returns how many. A page already
    /// showing the screen keeps its connection until it closes, but stops taking input within seconds.
    /// </summary>
    public async Task<int> RevokeLiveAsync(MachineRef machine, CancellationToken cancellationToken = default)
    {
        var d = await _http.JsonAsync(HttpMethod.Delete, $"/v1/agents/machines/{Http.Q(machine.Id)}/live", null, cancellationToken)
            .ConfigureAwait(false);
        return d.Int("revoked") ?? 0;
    }

    internal async Task<string> ResolveIdAsync(MachineRef? machine, CancellationToken cancellationToken)
    {
        if (machine is not null && machine.Id.Length > 0) return machine.Id;
        var machines = await ListAsync(cancellationToken).ConfigureAwait(false);
        if (machines.Count == 1) return machines[0].Id;
        if (machines.Count == 0)
            throw new BadRequestException("No computer on this account. Create one in the Sai app or the portal.");
        var names = string.Join(", ", machines.Select(m => m.Name is { Length: > 0 } ? $"{m.Id} ({m.Name})" : m.Id));
        throw new BadRequestException($"Several computers on this account; pass machine. Candidates: {names}");
    }
}
