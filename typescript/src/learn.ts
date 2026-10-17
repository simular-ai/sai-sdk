/**
 * Learn and judge (research preview): turn recorded turns, or a task the agent does first, into
 * Simulang code you own; repair that code; run, judge and repair it on a machine until it passes
 * (policy iteration); and judge turns against criteria you choose now.
 *
 * Maps to `/v1/agents/learn` and `/v1/agents/judge`.
 */

import type { Http } from './http.js'
import { RateLimitError } from './errors.js'
import { idOf, type MachineRef } from './machines.js'
import type { TurnRef } from './turns.js'
import {
  parseJudgement,
  parseLearnResult,
  parseLearnRun,
  type LearnRun,
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
/** How often `wait` reads a learn job; a job's steps take tens of seconds to minutes. */
const LEARN_POLL_INTERVAL_MS = 10_000

const turnId = (t: TurnRef): string => {
  const id = typeof t === 'string' ? t : t.id
  if (!id) throw new Error('This turn has no id: the message was answered without starting one.')
  return id
}

export interface LearnOptions {
  /**
   * The task, with `{{name}}` placeholders: `'Submit claim for {{patient}} to {{payer}}'`. Without
   * `turns`, the agent does this task first. With `turns`, it defaults to the first turn's.
   */
  taskTemplate?: string
  /** @deprecated Use `taskTemplate`. */
  template?: string
  /** A value for every placeholder; with `turns`, defaults to the first turn's. */
  inputs?: Record<string, string | number | boolean>
  /** Code to repair (with `maxIterations` 0), or to start the run-judge-repair loop from. */
  initialCode?: string
  /** How `initialCode` did on runs (a repair only). */
  evaluations?: Evaluation[]
  /** What you know about the task, for writing and repairing the code, e.g. "the Save button is under the ⋯ menu". */
  guidance?: string
  /** @deprecated Use `guidance`. */
  feedback?: string
  /**
   * Code versions to run, judge and repair: 0 (the default) only writes the code; 3 allows up to
   * two repairs. At most 5.
   */
  maxIterations?: number
  /** Runs per code version; a version passes when all of them pass. Default 3, at most 5. */
  rollouts?: number
  /** The machine to run on; optional with one machine. */
  machine?: MachineRef
  /** What "done" means for the judge; default: the task as written, with its inputs. */
  criteria?: string | Check[]
  /** Run before the agent run and before every run of the code: Simulang `code`, or a `task` for the agent. */
  reset?: { code: string } | { task: string }
  /** Judge the agent run first; if it fails, the job stops with the judgement and writes no code. */
  judgeInitialAgentRun?: boolean
  /** After a failed run, let the agent finish the task; its turn feeds the repair. */
  continueWithAgent?: boolean
  /** Limit of each run of the code, in minutes. Default 15. */
  rolloutMinutes?: number
  /** Limit of the agent run and of each reset task, in minutes. Default 15. */
  agentRunMinutes?: number
  /** Limit of each continuation, in minutes. Default 15. */
  continuationMinutes?: number
  /** Limit of the whole job, in minutes. Default 615, at most 690. */
  maxJobMinutes?: number
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
   * Make Simulang code, and optionally run, judge and repair it on a machine.
   *
   * - `create(turns)`: code from recorded turns (ordered, one session, each sent with
   *   `recordTrajectory`). Answers with the code (about two minutes).
   * - `create([], { initialCode, guidance | evaluations })`: a repair. Answers with the code.
   * - `create(turns, { maxIterations: 3 })` or `create([], { taskTemplate, inputs, maxIterations: 3 })`:
   *   a job on the machine (from `turns`, or after the agent does the task). Answers at once with
   *   `status: 'running'`; read it with `wait()`.
   *
   * A result with `validation.errors` comes back `failed`.
   */
  async create(turns: TurnRef[], opts: LearnOptions = {}): Promise<LearnResult> {
    const body: Record<string, unknown> = { turns: turns.map(turnId) }
    // The old names go out as sent, so code that uses them keeps working with an older API.
    if (opts.taskTemplate !== undefined) body.taskTemplate = opts.taskTemplate
    else if (opts.template !== undefined) body.template = opts.template
    if (opts.inputs !== undefined) body.inputs = opts.inputs
    if (opts.initialCode !== undefined) body.initialCode = opts.initialCode
    if (opts.evaluations) body.evaluations = opts.evaluations.map(evaluationJson)
    if (opts.guidance !== undefined) body.guidance = opts.guidance
    else if (opts.feedback !== undefined) body.feedback = opts.feedback
    if (opts.machine !== undefined) body.machineId = idOf(opts.machine)
    for (const k of [
      'maxIterations',
      'rollouts',
      'criteria',
      'reset',
      'judgeInitialAgentRun',
      'continueWithAgent',
      'rolloutMinutes',
      'agentRunMinutes',
      'continuationMinutes',
      'maxJobMinutes',
    ] as const) {
      if (opts[k] !== undefined) body[k] = opts[k]
    }
    if (opts.model !== undefined) body.model = opts.model
    if (opts.idempotencyKey !== undefined) body.idempotency_key = opts.idempotencyKey
    return parseLearnResult(
      await this.http.json('POST', '/v1/agents/learn', {
        json: body,
        timeoutMs: opts.timeoutMs ?? LEARN_TIMEOUT_MS,
      }),
    )
  }

  /** A learn call's result, or a job's progress so far. */
  async get(learnId: string): Promise<LearnResult> {
    return parseLearnResult(
      await this.http.json('GET', `/v1/agents/learn/${encodeURIComponent(learnId)}`),
    )
  }

  /**
   * Read a learn job until it ends (`succeeded`, `failed` or `stopped`). `timeoutMs` throws a
   * `TimeoutError` (DOMException) with the job still running; it keeps running.
   */
  async wait(
    job: LearnResult | string,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<LearnResult> {
    const learnId = typeof job === 'string' ? job : job.id
    const poll = opts.pollMs ?? LEARN_POLL_INTERVAL_MS
    const deadline = opts.timeoutMs === undefined ? null : Date.now() + opts.timeoutMs
    for (;;) {
      let r: LearnResult
      try {
        r = await this.get(learnId)
      } catch (err) {
        if (!(err instanceof RateLimitError)) throw err
        await sleep((err.retryAfter ?? 30) * 1000)
        continue
      }
      if (r.status !== 'running') return r
      if (deadline !== null && Date.now() + poll > deadline) {
        throw new DOMException(`Learn job ${learnId} is still running.`, 'TimeoutError')
      }
      await sleep(poll)
    }
  }

  /**
   * Stop a learn job at once, whatever step it is on. It keeps the last complete results and
   * reads `stopped` / `cancelled` once it has ended, normally within seconds.
   */
  async cancel(job: LearnResult | string): Promise<void> {
    const learnId = typeof job === 'string' ? job : job.id
    await this.http.json('POST', `/v1/agents/learn/${encodeURIComponent(learnId)}/cancel`)
  }

  /** One run of a learn job's code: what it returned and logged, and its judgement. */
  async rollout(job: LearnResult | string, iteration: number, rollout: number): Promise<LearnRun> {
    const learnId = typeof job === 'string' ? job : job.id
    return parseLearnRun(
      await this.http.json(
        'GET',
        `/v1/agents/learn/${encodeURIComponent(learnId)}/iterations/${iteration}/rollouts/${rollout}`,
      ),
    )
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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
