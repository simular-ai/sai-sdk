/**
 * Turns: what a message to Sai started or joined. Every message gets a turn id
 * (`turn.id`); this reads the turn's record: status, output, evidence, usage,
 * and its trajectory when the message set `recordTrajectory`.
 *
 * Maps to `/v1/agents/turns/*`.
 */

import type { Http } from './http.js'
import { waitTurnRecord } from './sessions.js'
import {
  parseTrajectoryStep,
  parseTurnRecord,
  type TrajectoryStep,
  type TurnRecord,
} from './types.js'

/** A turn id, a `Turn`, or a `TurnRecord`. */
export type TurnRef = string | { id: string | null }

const idOf = (turn: TurnRef): string => {
  const id = typeof turn === 'string' ? turn : turn.id
  if (!id) throw new Error('This turn has no id: the message was answered without starting one.')
  return encodeURIComponent(id)
}

export class Turns {
  constructor(private readonly http: Http) {}

  /** The turn's record now. Never waits: `finalizing` while the result is worked out. */
  async get(turn: TurnRef): Promise<TurnRecord> {
    return parseTurnRecord(await this.http.json('GET', `/v1/agents/turns/${idOf(turn)}`))
  }

  /**
   * Read the turn until it is `succeeded`, `failed` or `needs_input`. On
   * `needs_input`, answer the approval on the turn's session
   * (`sai.sessions.resume(record.sessionId)`) and wait again. `timeoutMs`
   * throws a `TimeoutError` (DOMException) with the turn unfinished.
   */
  async wait(turn: TurnRef, opts: { timeoutMs?: number } = {}): Promise<TurnRecord> {
    const deadline = opts.timeoutMs === undefined ? null : Date.now() + opts.timeoutMs
    return waitTurnRecord(this.http, decodeURIComponent(idOf(turn)), deadline, [
      'succeeded',
      'failed',
      'needs_input',
    ])
  }

  /** The steps the agent took, in order. Recorded only when the message set `recordTrajectory`. */
  async trajectory(turn: TurnRef): Promise<TrajectoryStep[]> {
    const d = await this.http.json<{ steps?: Record<string, unknown>[] }>(
      'GET',
      `/v1/agents/turns/${idOf(turn)}/trajectory`,
    )
    return (d.steps ?? []).map(parseTrajectoryStep)
  }

  /** The screen before step `index` (the last one is after the turn), as JPEG bytes. */
  async screenshot(turn: TurnRef, index: number): Promise<Uint8Array> {
    const res = await this.http.request(
      'GET',
      `/v1/agents/turns/${idOf(turn)}/trajectory/screenshots/${index}`,
    )
    return new Uint8Array(await res.arrayBuffer())
  }
}
