namespace Simular.Sai;

/// <summary>
/// What a message to Sai started or joined: its record (status, output, evidence, usage), and its
/// trajectory when the message set <c>RecordTrajectory</c>.
/// </summary>
public sealed class Turns
{
    private readonly Http _http;

    internal Turns(Http http) => _http = http;

    /// <summary>The turn's record now. Never waits: <c>finalizing</c> while the result is worked out.</summary>
    public async Task<TurnRecord> GetAsync(TurnRef turn, CancellationToken cancellationToken = default) =>
        TurnRecord.Parse(await _http.JsonAsync(HttpMethod.Get, $"/v1/agents/turns/{Http.Q(turn.RequireId())}", null, cancellationToken)
            .ConfigureAwait(false));

    /// <summary>
    /// Read the turn until it is <c>succeeded</c>, <c>failed</c> or <c>needs_input</c>. On
    /// <c>needs_input</c>, answer the approval on the turn's session and wait again.
    /// <paramref name="timeout"/> throws <see cref="TimeoutException"/> with the turn unfinished.
    /// </summary>
    public Task<TurnRecord> WaitAsync(TurnRef turn, TimeSpan? timeout = null, CancellationToken cancellationToken = default) =>
        Turn.WaitRecordAsync(
            _http, turn.RequireId(), timeout is { } t ? DateTimeOffset.UtcNow + t : null,
            [TurnRecordStatus.Succeeded, TurnRecordStatus.Failed, TurnRecordStatus.NeedsInput], cancellationToken);

    /// <summary>The steps the agent took, in order. Recorded only when the message set <c>RecordTrajectory</c>.</summary>
    public async Task<IReadOnlyList<TrajectoryStep>> TrajectoryAsync(TurnRef turn, CancellationToken cancellationToken = default)
    {
        var d = await _http.JsonAsync(HttpMethod.Get, $"/v1/agents/turns/{Http.Q(turn.RequireId())}/trajectory", null, cancellationToken)
            .ConfigureAwait(false);
        return d.Arr("steps").Select(TrajectoryStep.Parse).ToList();
    }

    /// <summary>The screen before step <paramref name="index"/> (the last one is after the turn), as JPEG bytes.</summary>
    public async Task<byte[]> ScreenshotAsync(TurnRef turn, int index, CancellationToken cancellationToken = default)
    {
        var (_, body) = await _http.RequestAsync(
            HttpMethod.Get, $"/v1/agents/turns/{Http.Q(turn.RequireId())}/trajectory/screenshots/{index}", null, cancellationToken)
            .ConfigureAwait(false);
        return body;
    }
}
