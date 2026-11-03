package ai.simular.sai;

import java.time.Duration;

/** Options for {@code turn.events()}. */
public final class EventsOptions {
  boolean raw;
  Duration pollWait;

  /** Also yield framing, reasoning and tool-call frames, as {@link EventKind#OTHER}. */
  public EventsOptions raw(boolean raw) {
    this.raw = raw;
    return this;
  }

  /** How long the server may hold one poll (whole seconds); it caps at 60. Default 30 s. */
  public EventsOptions pollWait(Duration pollWait) {
    this.pollWait = pollWait;
    return this;
  }
}
