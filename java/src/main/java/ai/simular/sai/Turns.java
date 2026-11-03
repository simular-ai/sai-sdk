package ai.simular.sai;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Turns: what a message to Sai started or joined. Every message gets a turn id ({@code turn.id()});
 * this reads the turn's record: status, output, evidence, usage, and its trajectory when the
 * message set {@code recordTrajectory}. Each method takes a {@link Turn}, a {@link TurnRecord} or
 * the id string.
 */
public final class Turns {
  static final List<TurnRecordStatus> DONE = List.of(TurnRecordStatus.SUCCEEDED, TurnRecordStatus.FAILED);
  private static final List<TurnRecordStatus> SETTLED =
      List.of(TurnRecordStatus.SUCCEEDED, TurnRecordStatus.FAILED, TurnRecordStatus.NEEDS_INPUT);
  /** Between turn reads; {@code GET /v1/agents/turns/{id}} never holds. */
  private static final long RECORD_POLL_INTERVAL_MS = 2_000;

  private final Http http;

  Turns(Http http) {
    this.http = http;
  }

  /** The turn's record now. Never waits: {@code finalizing} while the result is worked out. */
  public TurnRecord get(String turnId) {
    return TurnRecord.parse(http.object("GET", "/v1/agents/turns/" + Http.encode(TurnRef.idOf(turnId))));
  }

  public TurnRecord get(TurnRef turn) {
    return get(TurnRef.idOf(turn));
  }

  public TurnRecord waitFor(String turnId) {
    return waitFor(turnId, null);
  }

  public TurnRecord waitFor(TurnRef turn) {
    return waitFor(TurnRef.idOf(turn), null);
  }

  public TurnRecord waitFor(TurnRef turn, Duration timeout) {
    return waitFor(TurnRef.idOf(turn), timeout);
  }

  /**
   * Read the turn until it is {@code succeeded}, {@code failed} or {@code needs_input}. On {@code
   * needs_input}, answer the approval on the turn's session ({@code
   * sai.sessions().resume(record.sessionId())}) and wait again. {@code timeout} (null: none) throws
   * {@link SaiTimeoutException} with the turn unfinished.
   */
  public TurnRecord waitFor(String turnId, Duration timeout) {
    Long deadline = timeout == null ? null : System.currentTimeMillis() + timeout.toMillis();
    return waitRecord(http, TurnRef.idOf(turnId), deadline, SETTLED);
  }

  public List<TrajectoryStep> trajectory(String turnId) {
    Map<String, Object> d =
        http.object("GET", "/v1/agents/turns/" + Http.encode(TurnRef.idOf(turnId)) + "/trajectory");
    List<TrajectoryStep> out = new ArrayList<>();
    for (Map<String, Object> s : Json.objects(d.get("steps"))) out.add(TrajectoryStep.parse(s));
    return Collections.unmodifiableList(out);
  }

  /** The steps the agent took, in order. Recorded only when the message set {@code recordTrajectory}. */
  public List<TrajectoryStep> trajectory(TurnRef turn) {
    return trajectory(TurnRef.idOf(turn));
  }

  public byte[] screenshot(String turnId, int index) {
    return http.request(
            "GET",
            "/v1/agents/turns/" + Http.encode(TurnRef.idOf(turnId)) + "/trajectory/screenshots/" + index,
            null)
        .body();
  }

  /** The screen before step {@code index} (the last one is after the turn), as JPEG bytes. */
  public byte[] screenshot(TurnRef turn, int index) {
    return screenshot(TurnRef.idOf(turn), index);
  }

  /** Read the turn's record until its status is in {@code stop}; past {@code deadline} (epoch ms), time out. */
  static TurnRecord waitRecord(Http http, String turnId, Long deadline, List<TurnRecordStatus> stop) {
    for (;;) {
      TurnRecord record;
      try {
        record = TurnRecord.parse(http.object("GET", "/v1/agents/turns/" + Http.encode(turnId)));
      } catch (RateLimitException e) {
        Sleep.retryAfter(e);
        continue;
      }
      if (stop.contains(record.status())) return record;
      if (deadline != null && System.currentTimeMillis() + RECORD_POLL_INTERVAL_MS > deadline) {
        throw new SaiTimeoutException("Turn " + turnId + " still " + record.status() + ".");
      }
      Sleep.millis(RECORD_POLL_INTERVAL_MS);
    }
  }
}
