/**
 * Learn and judge (research preview): turn recorded turns into Simulang code you own, repair that
 * code, and judge turns against criteria you choose now.
 *
 * Maps to `/v1/agents/learn` and `/v1/agents/judge`.
 */

import type { Http } from './http.js'
import type { TurnRef } from './turns.js'
import {
  parseJudgement,
  parseLearnResult,
  type Check,
  type Evaluation,
  type ExecResult,
  type Judgement,
  type LearnResult,
} from './types.js'

/** A conversion is two model calls of up to a minute or two each, plus one retry. */
const LEARN_TIMEOUT_MS = 600_000
const JUDGE_TIMEOUT_MS = 180_000
/** The last log lines of a run sent with an evaluation; the API takes 20 KB per result. */
const EVAL_LOG_LINES = 30

const turnId = (t: TurnRef): string => {
  const id = typeof t === 'string' ? t : t.id
  if (!id) throw new Error('This turn has no id: the message was answered without starting one.')
  return id
}

export interface LearnOptions {
  /** `'Submit claim for {{patient}} to {{payer}}'`; default: the first turn's template, else inferred. */
  template?: string
  /** Code to repair (heal). Without it, the turns are converted. */
  initialCode?: string
  /** How `initialCode` did on runs. */
  evaluations?: Evaluation[]
  /** Your note for the repair, e.g. "the Save dialog changed". */
  feedback?: string
  /** A model id from `sai.models.list()`; default `anthropic/claude-opus-5-5`. */
  model?: string
  /** The same key again returns the earlier result and runs nothing. */
  idempotencyKey?: string
  timeoutMs?: number
}

function evaluationJson(e: Evaluation): Record<string, unknown> {
  const r: ExecResult | undefined = e.result
  return {
    inputs: e.inputs,
    ...(r && {
      result: {
        result: r.result,
        logs: r.logs.slice(-EVAL_LOG_LINES),
        ...(r.error && { error: { kind: r.error.kind, message: r.error.message } }),
      },
    }),
    ...(e.judgement !== undefined && {
      judgement: typeof e.judgement === 'string' ? e.judgement : e.judgement.id,
    }),
    ...(e.passed !== undefined && { passed: e.passed }),
    ...(e.note !== undefined && { note: e.note }),
  }
}

export class Learn {
  constructor(private readonly http: Http) {}

  /**
   * Make Simulang code from `turns` (ordered, one session, each sent with `recordTrajectory`), or,
   * with `initialCode`, repair it from `evaluations`, `feedback` or new `turns`. Waits for the
   * result (about two minutes). A result with `validation.errors` comes back `failed`.
   */
  async create(turns: TurnRef[], opts: LearnOptions = {}): Promise<LearnResult> {
    const body: Record<string, unknown> = { turns: turns.map(turnId) }
    if (opts.template !== undefined) body.template = opts.template
    if (opts.initialCode !== undefined) body.initialCode = opts.initialCode
    if (opts.evaluations) body.evaluations = opts.evaluations.map(evaluationJson)
    if (opts.feedback !== undefined) body.feedback = opts.feedback
    if (opts.model !== undefined) body.model = opts.model
    if (opts.idempotencyKey !== undefined) body.idempotency_key = opts.idempotencyKey
    return parseLearnResult(
      await this.http.json('POST', '/v1/agents/learn', {
        json: body,
        timeoutMs: opts.timeoutMs ?? LEARN_TIMEOUT_MS,
      }),
    )
  }

  /** A learn call's result, e.g. after the request timed out on your side. */
  async get(learnId: string): Promise<LearnResult> {
    return parseLearnResult(
      await this.http.json('GET', `/v1/agents/learn/${encodeURIComponent(learnId)}`),
    )
  }
}

export interface JudgeOptions {
  /** Default: the first turn's message. */
  task?: string
  idempotencyKey?: string
  timeoutMs?: number
}

export class Judge {
  constructor(private readonly http: Http) {}

  /**
   * Judge recorded `turns` (one session, as one task) against `criteria`: a sentence for a model
   * to judge, or a list of `Check`s. Nothing runs again, and the turns do not change.
   */
  async create(
    turns: TurnRef[],
    criteria: string | Check[],
    opts: JudgeOptions = {},
  ): Promise<Judgement> {
    const body: Record<string, unknown> = { turns: turns.map(turnId), criteria }
    if (opts.task !== undefined) body.task = opts.task
    if (opts.idempotencyKey !== undefined) body.idempotency_key = opts.idempotencyKey
    return parseJudgement(
      await this.http.json('POST', '/v1/agents/judge', {
        json: body,
        timeoutMs: opts.timeoutMs ?? JUDGE_TIMEOUT_MS,
      }),
    )
  }

  async get(judgementId: string): Promise<Judgement> {
    return parseJudgement(
      await this.http.json('GET', `/v1/agents/judge/${encodeURIComponent(judgementId)}`),
    )
  }
}
