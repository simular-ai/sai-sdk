package ai.simular.sai;

import java.time.Duration;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;

/**
 * One message's work. Iterate {@code events()} to watch it, or {@code waitFor()} for the result.
 * {@code id()} is the turn the message started, or the running turn it joined ({@code
 * sai.turns().get(turn)}); null when the message was answered without one.
 */
public final class Turn implements TurnRef {
  private static final int POLL_WAIT = 30;

  private final Session session;
  private final Http http;
  private final boolean queued;
  private final String id;
  private final boolean structured;
  private final TurnRecord replay;
  // answered without starting a task, or an idempotent replay: no events to poll
  private final boolean local;
  private String cursor;
  private volatile TurnResult last;

  Turn(Session session, Http http, boolean queued, TurnResult done, String id, boolean structured, TurnRecord replay) {
    this.session = session;
    this.http = http;
    this.queued = queued;
    this.last = done;
    this.id = id;
    this.structured = structured;
    this.replay = replay;
    this.local = done != null || replay != null;
  }

  @Override
  public String id() {
    return id;
  }

  /** True when the message joined a running turn to steer it. */
  public boolean queued() {
    return queued;
  }

  public Session session() {
    return session;
  }

  /** The last known status; {@code running} before the first poll. */
  public TurnStatus status() {
    TurnResult r = last;
    return r == null ? TurnStatus.RUNNING : r.status();
  }

  /** The last known state, or null before the first poll. */
  public TurnResult result() {
    return last;
  }

  public Iterable<Event> events() {
    return events(new EventsOptions());
  }

  /**
   * Events until the turn is idle or errors, polled as you iterate. It keeps going through {@code
   * needs_approval}: answer with {@code turn.respond(ev.approval(), ...)} inside the loop, or let a
   * human answer a link-only approval in a browser. Without {@code raw}, framing, reasoning and
   * tool-call frames are skipped.
   */
  public Iterable<Event> events(EventsOptions opts) {
    EventsOptions o = opts == null ? new EventsOptions() : opts;
    int wait = o.pollWait == null ? POLL_WAIT : (int) o.pollWait.toSeconds();
    return () ->
        new Iterator<>() {
          private final ArrayDeque<Event> buffer = new ArrayDeque<>();
          private boolean ended = local;

          @Override
          public boolean hasNext() {
            while (buffer.isEmpty() && !ended) {
              Map<String, Object> page = poll(wait);
              for (Map<String, Object> e : Json.objects(page.get("events"))) {
                Event ev = Event.parse(e);
                if (o.raw || ev.kind() != EventKind.OTHER) buffer.add(ev);
              }
              Object status = page.get("status");
              if ("idle".equals(status) || "error".equals(status)) ended = true;
            }
            return !buffer.isEmpty();
          }

          @Override
          public Event next() {
            if (!hasNext()) throw new NoSuchElementException();
            return buffer.poll();
          }
        };
  }

  public TurnResult waitFor() {
    return waitFor(new WaitOptions());
  }

  /**
   * Wait until the turn is done, or stops on an approval nobody answered. Without {@code
   * onApproval}, returns with status {@code needs_approval} and the {@code approval} so the caller
   * can decide. With it, the handler's answer is sent and waiting continues; a handler returning
   * null leaves the approval to someone else (a link-only one to a human) and keeps waiting. For a
   * structured message, it then waits for the turn's record ({@code result.record()}: output,
   * evidence), which is worked out after the turn. {@code timeout} throws {@link
   * SaiTimeoutException} with the turn still running.
   */
  public TurnResult waitFor(WaitOptions opts) {
    WaitOptions o = opts == null ? new WaitOptions() : opts;
    Long deadline = o.timeout == null ? null : System.currentTimeMillis() + o.timeout.toMillis();
    if (replay != null) {
      TurnRecord record = replay.done() ? replay : Turns.waitRecord(http, replay.id(), deadline, Turns.DONE);
      String sid = record.sessionId() != null ? record.sessionId() : session.id() != null ? session.id() : "";
      last = replayResult(record, sid);
      return last;
    }
    if (local) return last;
    Set<String> answered = new HashSet<>();
    for (;;) {
      int pollWait = o.pollWait == null ? POLL_WAIT : (int) o.pollWait.toSeconds();
      if (deadline != null) {
        long left = deadline - System.currentTimeMillis();
        if (left <= 0) {
          throw new SaiTimeoutException(
              "Turn still " + status() + " after " + o.timeout.toMillis() + "ms (session " + session.id() + ").");
        }
        pollWait = (int) Math.max(1, Math.min(pollWait, left / 1000));
      }
      Map<String, Object> page = poll(pollWait);
      Object status = page.get("status");
      if ("idle".equals(status) || "error".equals(status)) {
        if (structured && id != null) {
          last = last.withRecord(Turns.waitRecord(http, id, deadline, Turns.DONE));
        }
        return last;
      }
      Approval approval = last.approval();
      if (!"needs_approval".equals(status) || approval == null) continue;
      if (o.onApproval == null) return last;
      if (answered.contains(approval.id())) continue;
      ApprovalAnswer answer = o.onApproval.answer(approval);
      answered.add(approval.id());
      if (answer == null) continue;
      try {
        session.respond(approval, answer.response(), answer.selections());
      } catch (ConflictException e) {
        // answered elsewhere or expired; the next poll shows the new state
      }
    }
  }

  /** Answer an approval on this turn's session; see {@link Session#respond(Approval, String, List)}. */
  public String respond(Approval approval) {
    return session.respond(approval);
  }

  public String respond(Approval approval, String response) {
    return session.respond(approval, response);
  }

  public String respond(Approval approval, String response, List<List<String>> selections) {
    return session.respond(approval, response, selections);
  }

  public String respond(String approvalId) {
    return session.respond(approvalId);
  }

  public String respond(String approvalId, String response) {
    return session.respond(approvalId, response);
  }

  public String respond(String approvalId, String response, List<List<String>> selections) {
    return session.respond(approvalId, response, selections);
  }

  /** Stop the session's running turn. False if nothing was running. */
  public boolean abort() {
    return session.abort();
  }

  private synchronized Map<String, Object> poll(int wait) {
    Map<String, Object> page;
    for (;;) {
      try {
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("sessionId", session.id() == null ? "" : session.id());
        params.put("wait", wait);
        params.put("since", cursor);
        page = http.object("GET", "/v1/agents/events",
            Http.Req.params(params).timeout(Duration.ofSeconds(wait + 30L)));
        break;
      } catch (RateLimitException e) {
        Sleep.retryAfter(e);
      }
    }
    if (page.get("cursor") instanceof String c) cursor = c;
    TurnResult prev = last;
    String error = prev == null ? null : prev.error();
    String errorCode = prev == null ? null : prev.errorCode();
    for (Map<String, Object> e : Json.objects(page.get("events"))) {
      if ("error".equals(e.get("type"))) {
        if (e.get("errorText") instanceof String t) error = t;
        if (e.get("code") instanceof String c) errorCode = c;
      }
    }
    TurnStatus status = TurnStatus.of(Json.str(page.get("status"), "running"));
    Map<String, Object> approval = Json.truthy(page.get("approval")) ? Json.obj(page.get("approval")) : null;
    String sid = Json.str(page.get("sessionId"), session.id() == null ? "" : session.id());
    last =
        new TurnResult(
            status,
            Json.str(page.get("text"), ""),
            sid,
            approval == null ? null : Approval.parse(approval),
            error,
            errorCode,
            Usage.parse(page.get("usage")),
            Usage.parse(page.get("sessionUsage")),
            null,
            status == TurnStatus.IDLE);
    return page;
  }

  // A turn that failed for these reasons still has the agent's answer; the turn itself did not break.
  private static final List<String> ANSWERED_REASONS =
      List.of("output_invalid", "criteria_not_met", "criteria_unchecked");

  /** The result the live path would have returned for this finished turn, from its record. */
  private static TurnResult replayResult(TurnRecord record, String sessionId) {
    String raw = record.rawAnswer();
    String text = raw != null && !raw.isEmpty() ? raw : outputText(record.output());
    TurnResult r = TurnResult.local(sessionId, text);
    if (record.status() == TurnRecordStatus.FAILED
        && !ANSWERED_REASONS.contains(record.reasonCode() == null ? "" : record.reasonCode())) {
      String error =
          raw != null && !raw.isEmpty()
              ? raw
              : "The turn failed (" + (record.reasonCode() == null ? "unknown" : record.reasonCode()) + ").";
      r = new TurnResult(TurnStatus.ERROR, "", sessionId, null, error, record.errorCode(), null, null, null, true);
    }
    r = new TurnResult(r.status(), r.text(), r.sessionId(), r.approval(), r.error(), r.errorCode(),
        record.usage(), r.sessionUsage(), null, r.ok());
    return r.withRecord(record);
  }

  /** {@code output} as text: a plain message's answer as is, an {@code outputSchema} object as JSON. */
  private static String outputText(Object output) {
    if (output == null) return "";
    return output instanceof String s ? s : Json.stringify(output);
  }
}
