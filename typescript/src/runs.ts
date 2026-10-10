/**
 * Runs: one message's result. Every message is a run; a message with a
 * contract (inputs, output schema, success criteria) is a structured run.
 *
 * Maps to `POST /v1/agents/message` (without a session) and `/v1/runs/*`.
 */

import type { Http } from './http.js'
import type { MachineRef, Machines } from './machines.js'
import { Session, waitRun, type SendOptions, type Turn } from './sessions.js'
import { parseRun, parseTrajectoryStep, type Run, type TrajectoryStep } from './types.js'

export type RunRef = Run | string

const idOf = (run: RunRef): string => encodeURIComponent(typeof run === 'string' ? run : run.id)

export class Runs {
  constructor(
    private readonly http: Http,
    private readonly machines: Machines,
  ) {}

  /**
   * Send a message without a session. A structured run opens a session of its
   * own, so its result does not depend on earlier conversations, and gives the
   * machine back when its turn ends unless `keepLockAtTurnEnd`. A plain message
   * goes to the machine's API conversation. `turn.session` continues the run's
   * session. Options as on `Session.send()`.
   */
  async create(message: string, opts: SendOptions & { machine?: MachineRef } = {}): Promise<Turn> {
    const { machine, ...send } = opts
    const session = new Session(this.http, await this.machines.resolveId(machine), null)
    return session.send(message, send)
  }

  /** The run's status and, once done, its output, reason code, evidence and usage. */
  async get(run: RunRef): Promise<Run> {
    return parseRun(await this.http.json('GET', `/v1/runs/${idOf(run)}`))
  }

  /**
   * Read the run until it is `succeeded`, `failed` or `needs_input`. On
   * `needs_input`, answer the approval on the run's session
   * (`sai.sessions.resume(run.sessionId)`) and wait again. `timeoutMs` throws a
   * `TimeoutError` (DOMException) with the run unfinished.
   */
  async wait(run: RunRef, opts: { timeoutMs?: number } = {}): Promise<Run> {
    const deadline = opts.timeoutMs === undefined ? null : Date.now() + opts.timeoutMs
    return waitRun(this.http, typeof run === 'string' ? run : run.id, deadline, [
      'succeeded',
      'failed',
      'needs_input',
    ])
  }

  /** The steps the agent took, in order. Recorded only when the message set `recordTrajectory`. */
  async trajectory(run: RunRef): Promise<TrajectoryStep[]> {
    const d = await this.http.json<{ steps?: Record<string, unknown>[] }>(
      'GET',
      `/v1/runs/${idOf(run)}/trajectory`,
    )
    return (d.steps ?? []).map(parseTrajectoryStep)
  }

  /** The screen before step `index` (the last one is after the turn), as JPEG bytes. */
  async screenshot(run: RunRef, index: number): Promise<Uint8Array> {
    const res = await this.http.request(
      'GET',
      `/v1/runs/${idOf(run)}/trajectory/screenshots/${index}`,
    )
    return new Uint8Array(await res.arrayBuffer())
  }
}
