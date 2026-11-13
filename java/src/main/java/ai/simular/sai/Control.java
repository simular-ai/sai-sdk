package ai.simular.sai;

import java.time.Duration;

/**
 * Direct control: drive a computer with Simulang. No agent. A lease on the machine: at most
 * one per machine. Research preview; model calls the code makes are billed as usual.
 */
public final class Control {
  private final Http http;

  Control(Http http) {
    this.http = http;
  }

  /**
   * Take a computer. Returns once the lease holds it, up to ~3 minutes when a Sai task holds
   * it or it has to start; at once if the lease is already open. Close it when done
   * (try-with-resources): Sai's tasks on that computer wait until then.
   */
  public ControlLease open(String machineId) {
    var d = http.object("POST", ControlLease.path(machineId), new Http.Req().timeout(Duration.ofSeconds(240)));
    return new ControlLease(http, machineId, Json.lng(d.get("expiresAfterIdleSec")));
  }

  public ControlLease open(Machine machine) {
    return open(machine.id());
  }
}
