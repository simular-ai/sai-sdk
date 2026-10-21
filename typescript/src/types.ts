/**
 * Response objects. Each keeps the server's JSON in `raw`, so a field the SDK
 * does not model yet is still reachable.
 */

type Json = Record<string, unknown>

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown, d = 0): number => (typeof v === 'number' ? v : d)
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})

export interface Account {
  userId: string
  planId: string | null
  planTitle: string
  free: boolean
  unlimited: boolean
  /** Spendable credit in USD; null on the unlimited plan or when billing could not be reached. */
  creditsUsd: number | null
  raw: Json
}

export function parseAccount(d: Json): Account {
  const plan = obj(d.plan)
  const credits = obj(d.credits)
  return {
    userId: str(d.userId) ?? '',
    planId: str(plan.id) ?? null,
    planTitle: str(plan.title) ?? '',
    free: Boolean(plan.free),
    unlimited: Boolean(plan.unlimited),
    creditsUsd: typeof credits.usd === 'number' ? credits.usd : null,
    raw: d,
  }
}

export interface Model {
  id: string
  name: string
  provider: string
  tier: string
  costTier: string
  allowed: boolean
  raw: Json
}

export function parseModel(d: Json): Model {
  const id = str(d.id) ?? ''
  return {
    id,
    name: str(d.name) ?? id,
    provider: str(d.provider) ?? '',
    tier: str(d.tier) ?? '',
    costTier: str(d.costTier) ?? '',
    allowed: d.allowed === undefined ? true : Boolean(d.allowed),
    raw: d,
  }
}

export interface Machine {
  id: string
  name: string | null
  /** `cloud` (hosted by Simular) or `own` (a desktop with the Sai app). */
  kind: string
  /** True when a message can reach it now (a hibernated cloud computer wakes on the first message). */
  online: boolean
  /**
   * `running`, `starting`, `asleep`, `creating` or `unknown`; `null` on servers that do not
   * send it yet. Prefer it over `status`.
   */
  state: string | null
  /** @deprecated The server's internal lifecycle value; it may gain values at any time. Use `state`. */
  status: string | null
  canWake: boolean
  raw: Json
}

export function parseMachine(d: Json): Machine {
  return {
    id: str(d.machineId) ?? '',
    name: str(d.name) ?? null,
    kind: str(d.kind) ?? '',
    online: Boolean(d.online),
    state: str(d.state) ?? null,
    status: str(d.status) ?? null,
    canWake: Boolean(d.canWake),
    raw: d,
  }
}

/** One of your customers under an Organisation. */
export interface Tenant {
  id: string
  name: string
  /** Your id for the customer. Unique in the Organisation; set on create only. */
  externalId: string | null
  metadata: Record<string, string>
  /** `active` or `disabled`. */
  status: string
  /** Unix time in milliseconds. */
  createdAt: number
  disabledAt: number | null
  machineCount: number
  raw: Json
}

export function parseTenant(d: Json): Tenant {
  return {
    id: str(d.tenantId) ?? '',
    name: str(d.name) ?? '',
    externalId: str(d.externalId) ?? null,
    metadata: obj(d.metadata) as Record<string, string>,
    status: str(d.status) ?? '',
    createdAt: num(d.createdAt),
    disabledAt: typeof d.disabledAt === 'number' ? d.disabledAt : null,
    machineCount: num(d.machineCount),
    raw: d,
  }
}

export interface TenantPage {
  tenants: Tenant[]
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null
}

/** A Tenant's own computer, running the Sai runtime. */
export interface TenantMachine {
  id: string
  name: string | null
  platform: string | null
  status: string
  /** True when the machine reported in the last 3 minutes. */
  online: boolean
  lastSeen: number | null
  runtimeVersion: string | null
  raw: Json
}

export function parseTenantMachine(d: Json): TenantMachine {
  return {
    id: str(d.machineId) ?? '',
    name: str(d.name) ?? null,
    platform: str(d.platform) ?? null,
    status: str(d.status) ?? '',
    online: Boolean(d.online),
    lastSeen: typeof d.lastSeen === 'number' ? d.lastSeen : null,
    runtimeVersion: str(d.runtimeVersion) ?? null,
    raw: d,
  }
}

export interface Enrollment {
  /** Single use. Treat it as a secret until the Sai runtime redeems it. */
  token: string
  /** Unix time in milliseconds, 15 minutes after it was created. */
  expiresAt: number
  raw: Json
}

export function parseEnrollment(d: Json): Enrollment {
  return { token: str(d.enrollmentToken) ?? '', expiresAt: num(d.expiresAt), raw: d }
}

export interface TenantToken {
  /** Pass as `new Sai({ apiKey })` to act as the Tenant on sessions, machines and turns. */
  token: string
  /** Unix time in milliseconds, an hour after the exchange. There is no refresh: exchange again. */
  expiresAt: number
  tenantId: string
  raw: Json
}

export function parseTenantToken(d: Json): TenantToken {
  return {
    token: str(d.token) ?? '',
    expiresAt: num(d.expiresAt),
    tenantId: str(d.tenantId) ?? '',
    raw: d,
  }
}

/** A file uploaded with `sai.files.upload()`. Pass it in `attachments`. */
export interface Attachment {
  fileId: string
  name: string
  mime: string
  size: number
  raw: Json
}

export function parseAttachment(d: Json): Attachment {
  return {
    fileId: str(d.fileId) ?? '',
    name: str(d.name) ?? '',
    mime: str(d.mime) ?? '',
    size: num(d.size),
    raw: d,
  }
}

/** A view-only Guacamole stream of a computer's screen. The URL carries a token: keep it private. */
export interface LiveView {
  machineId: string
  websocketUrl: string
  width: number
  height: number
}

/** Sai is waiting for permission (or for an answer to a choice question). */
export interface Approval {
  id: string
  title: string
  description: string
  /** `exec`, `choice`, ...; a `choice` needs `selections` when approved. */
  type: string
  /** True: a human must answer in a browser at `url`; the API cannot. */
  isLinkOnly: boolean
  url: string | null
  command: string | null
  questions: Json[]
  raw: Json
}

export function parseApproval(d: Json): Approval {
  return {
    id: str(d.approvalId) ?? '',
    title: str(d.title) ?? '',
    description: str(d.description) ?? '',
    type: str(d.approvalType) ?? '',
    isLinkOnly: Boolean(d.isLinkOnly),
    url: str(d.approvalUrl) ?? null,
    command: str(d.command) ?? null,
    questions: Array.isArray(d.questions) ? (d.questions as Json[]) : [],
    raw: d,
  }
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  modelCalls: number
  byModel: Json
}

export function parseUsage(d: unknown): Usage | null {
  if (!d || typeof d !== 'object') return null
  const u = d as Json
  return {
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    cacheReadTokens: num(u.cacheReadTokens),
    cacheWriteTokens: num(u.cacheWriteTokens),
    costUsd: num(u.costUsd),
    modelCalls: num(u.modelCalls),
    byModel: obj(u.byModel),
  }
}

/** The SDK's event kinds. `other` only appears with `events({ raw: true })`. */
export const EVENT_KINDS = [
  'step',
  'message',
  'approval',
  'tool_error',
  'error',
  'finished',
  'other',
] as const
export type EventKind = (typeof EVENT_KINDS)[number]

// Wire event type → SDK kind. Anything not listed is framing or internal detail,
// and is yielded only with `events({ raw: true })`.
const KINDS: Record<string, EventKind> = {
  'data-progress': 'step',
  'text-delta': 'message',
  'data-approval-request': 'approval',
  'tool-output-error': 'tool_error',
  error: 'error',
  finish: 'finished',
}

/**
 * One thing that happened in a turn. `kind` is the SDK's name; `type` is the
 * wire type.
 */
export interface Event {
  kind: EventKind
  type: string
  text: string | null
  approval: Approval | null
  /** `insufficient_credits` / `free_computer_time_exhausted` on errors: stop retrying today. */
  code: string | null
  raw: Json
}

export function parseEvent(d: Json): Event {
  const t = str(d.type) ?? ''
  const data = obj(d.data)
  let text: string | null = null
  let approval: Approval | null = null
  if (t === 'data-progress') text = str(data.text) ?? null
  else if (t === 'text-delta' || t === 'reasoning-delta') text = str(d.delta) ?? null
  else if (t === 'tool-output-error' || t === 'error') text = str(d.errorText) ?? null
  else if (t === 'data-approval-request' && data.approvalId) {
    approval = parseApproval(data)
    text = approval.title
  }
  return { kind: KINDS[t] ?? 'other', type: t, text, approval, code: str(d.code) ?? null, raw: d }
}

/** Turn statuses: `running` while polling, then one of the three below. */
export const TURN_STATUSES = ['running', 'idle', 'needs_approval', 'error'] as const
export type TurnStatus = (typeof TURN_STATUSES)[number]

/**
 * Where a turn stopped. `status` is `idle` (done: `text` is the answer),
 * `error`, or `needs_approval` (waiting on `approval`; answer it and call
 * `wait()` again). `record` is the turn's record for a structured message (one
 * with `inputs`, `outputSchema` or `successCriteria`).
 */
export interface TurnResult {
  status: TurnStatus
  text: string
  sessionId: string
  approval: Approval | null
  error: string | null
  errorCode: string | null
  usage: Usage | null
  sessionUsage: Usage | null
  record: TurnRecord | null
  /** Idle, and for a structured message, the turn succeeded. */
  ok: boolean
}

/** One yes/no constraint a structured message's turn is checked against after it ends. */
export interface Check {
  /** Letters, digits, `_` or `-`; at most 64 characters. */
  id: string
  check: string
  /** Also return one sentence of evidence for this check (an extra model call). */
  returnEvidence?: boolean
}

/** The verdict on one success criterion. */
export interface Evidence {
  /** The check's id; null for a natural-language `successCriteria`. */
  id: string | null
  passed: boolean
  /** The probability that the check holds (`Check` criteria only). */
  score: number | null
  /** Always for a natural-language criteria; for a `Check`, only with `returnEvidence`. */
  evidence: string | null
}

/** Turn record statuses, from `GET /v1/agents/turns/{id}`. */
export const TURN_RECORD_STATUSES = [
  'running',
  'needs_input',
  'finalizing',
  'succeeded',
  'failed',
] as const
export type TurnRecordStatus = (typeof TURN_RECORD_STATUSES)[number]

/**
 * A turn's record. `status` is `running`, `needs_input` (an approval or
 * question is pending), `finalizing` (the agent is done; output and checks are
 * being worked out), `succeeded` or `failed`. On `failed`, `reasonCode` says
 * why: `agent_error` (with `errorCode` when known), `machine_unavailable`,
 * `not_started`, and for a structured message `output_invalid` (see `rawAnswer`
 * and `outputErrors`), `criteria_not_met` or `criteria_unchecked`.
 */
export interface TurnRecord {
  id: string
  sessionId: string | null
  machineId: string
  status: TurnRecordStatus
  /** The agent's final text; with `outputSchema`, an object matching it. */
  output: unknown
  reasonCode: string | null
  rawAnswer: string | null
  /** `insufficient_credits` or `free_computer_time_exhausted`, for a known `agent_error`. */
  errorCode: string | null
  outputErrors: string[]
  /** Empty for a plain message. */
  evidence: Evidence[]
  /** Tokens of every model call the agent made in the turn. */
  usage: Usage | null
  recordTrajectory: boolean
  /** At least one step was stored (`sai.turns.trajectory()`). */
  trajectoryRecorded: boolean
  template: string | null
  inputs: Json | null
  /** True when `idempotencyKey` matched an earlier turn: this is that turn, and nothing was sent. */
  replayed: boolean
  done: boolean
  ok: boolean
  raw: Json
}

export function parseTurnRecord(d: Json): TurnRecord {
  const status = (str(d.status) ?? 'running') as TurnRecordStatus
  const trajectory = d.trajectory && typeof d.trajectory === 'object' ? (d.trajectory as Json) : {}
  return {
    id: str(d.turnId) ?? '',
    sessionId: str(d.sessionId) ?? null,
    machineId: str(d.machineId) ?? '',
    status,
    output: d.output ?? null,
    reasonCode: str(d.reason_code) ?? null,
    rawAnswer: str(d.raw_answer) ?? null,
    errorCode: str(d.error_code) ?? null,
    outputErrors: Array.isArray(d.output_errors) ? (d.output_errors as string[]) : [],
    evidence: (Array.isArray(d.evidence) ? (d.evidence as Json[]) : []).map((e) => ({
      id: str(e.id) ?? null,
      passed: Boolean(e.passed),
      score: typeof e.score === 'number' ? e.score : null,
      evidence: str(e.evidence) ?? null,
    })),
    usage: parseUsage(d.usage),
    recordTrajectory: Boolean(d.recordTrajectory),
    trajectoryRecorded: Boolean(trajectory.recorded),
    template: str(d.template) ?? null,
    inputs: d.inputs && typeof d.inputs === 'object' ? (d.inputs as Json) : null,
    replayed: Boolean(d.idempotent_replay),
    done: status === 'succeeded' || status === 'failed',
    ok: status === 'succeeded',
    raw: d,
  }
}

/** One step the agent took: what it did, and why. Fetch its screen with `sai.turns.screenshot()`. */
export interface TrajectoryStep {
  index: number
  /** The screenshot taken when the turn ended, after the last step. */
  final: boolean
  timestamp: string
  title: string | null
  code: string | null
  /** The agent's text before the action. */
  rationale: string | null
  error: string | null
  hasScreenshot: boolean
  raw: Json
}

export function parseTrajectoryStep(d: Json): TrajectoryStep {
  return {
    index: num(d.index),
    final: Boolean(d.final),
    timestamp: str(d.timestamp) ?? '',
    title: str(d.title) ?? null,
    code: str(d.code) ?? null,
    rationale: str(d.rationale) ?? null,
    error: str(d.error) ?? null,
    hasScreenshot: Boolean(d.screenshot),
    raw: d,
  }
}

export interface ExecError {
  /** `exception`, `timeout` or `interrupted`. */
  kind: string
  message: string
  stack: string | null
}

/** What one Simulang block returned. A block that threw is still a result: check `error`. */
export interface ExecResult {
  result: unknown
  logs: string[]
  error: ExecError | null
  /** The screenshot the block captured (page/app snapshot, pageContent), decoded. */
  screenshot: Uint8Array | null
  /** `image/jpeg` or `image/png`. */
  screenshotMimeType: string | null
  /** @deprecated Use `screenshot`. Not always PNG; see `screenshotMimeType`. */
  screenshotPng?: Uint8Array | null
  screenshotOmitted: boolean
  variables: Json[]
  durationMs: number
  ok: boolean
  raw: Json
}

export function parseExecResult(d: Json): ExecResult {
  const obs = obj(d.observations)
  const shot = obj(obs.screenshot)
  const err = d.error ? obj(d.error) : null
  const b64 = str(shot.base64)
  const screenshot = b64 ? Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) : null
  const error = err
    ? { kind: str(err.kind) ?? '', message: str(err.message) ?? '', stack: str(err.stack) ?? null }
    : null
  return {
    result: d.result ?? null,
    logs: Array.isArray(d.logs) ? (d.logs as string[]) : [],
    error,
    screenshot,
    screenshotMimeType: str(shot.mimeType) ?? null,
    screenshotPng: screenshot,
    screenshotOmitted: Boolean(obs.screenshotOmitted),
    variables: Array.isArray(d.variables) ? (d.variables as Json[]) : [],
    durationMs: num(d.durationMs),
    ok: error === null,
    raw: d,
  }
}

/** One input of learned code: a `{{name}}` in the template and a key of `main`'s `params`. */
export interface LearnParameter {
  name: string
  defaultValue: string
  description: string | null
}

/** How learned code did on one run, for `sai.learn.create(..., { initialCode, evaluations })`. */
export interface Evaluation {
  inputs: Record<string, string | number | boolean>
  /** The run's result from `lease.exec()` / `lease.run()`; its screenshot is not sent. */
  result?: ExecResult
  /** A judgement of the run, or its id. */
  judgement?: Judgement | string
  passed?: boolean
  note?: string
}

/** What a `reset` did before a run or before the agent run. */
export interface LearnReset {
  kind: 'code' | 'task'
  ok: boolean
  durationMs: number | null
  /** A reset task's turn. */
  turnId: string | null
  error: string | null
}

/** One run of a version of the code in a learn job. */
export interface LearnRollout {
  index: number
  /**
   * `stopped`: the job stopped during this run (see the job's `stopReason`); `error`: the run could
   * not be judged; `null` while the run is going.
   */
  verdict: 'passed' | 'failed' | 'error' | 'stopped' | null
  reset: LearnReset | null
  error: string | null
  result: Json | null
  durationMs: number | null
  judgementId: string | null
  /** The judge's summary. */
  summary: string | null
  /** With `continueWithAgent`, the agent's turn after this failed run. */
  continuationTurnId: string | null
  continuationTimedOut: boolean
}

/** One version of the code in a learn job and its runs. */
export interface LearnIteration {
  /** 1-based. */
  index: number
  /** The convert or heal record that wrote this version (`sai.learn.get()` reads it). */
  learnId: string | null
  /** What the repair changed and why. */
  changes: string | null
  passed: number
  runs: number
  rollouts: LearnRollout[]
}

/** How the returned code did when it was run, on `inputs` only. */
export interface LearnTestResult {
  /** `not_judged`: the code was not run all its runs; `passed`: it passed every run; `failed`: a run failed. */
  status: 'not_judged' | 'passed' | 'failed'
  passedRuns: number
  requiredRuns: number
  inputs: Record<string, string | number | boolean> | null
}

/**
 * The result of `sai.learn.create()`: Simulang code made from recorded turns or from an agent
 * run, a repair of code you sent, or a learn job that runs, judges and repairs the code. Run the
 * code with `lease.run(learned, inputs)`. Research preview.
 */
export interface LearnResult {
  id: string
  /** `convert` (code from turns), `heal` (a repair of `initialCode`), or `policyIteration` (a job that runs the code). */
  mode: 'convert' | 'heal' | 'policyIteration'
  /**
   * Whether the call did its work: `running` while a job runs; `failed` when it wrote no code
   * (e.g. `validation.errors`); `stopped` when a job ended early (see `stopReason`).
   * How the code did is `testResult`.
   */
  status: 'succeeded' | 'failed' | 'running' | 'stopped'
  /** Why a job ended early, e.g. `cancelled`, `time_limit`, `agent_failed`, `interrupted`. */
  stopReason: string | null
  /** One sentence on why a job stopped. */
  message: string | null
  /** How the returned code did when it was run. */
  testResult: LearnTestResult | null
  /** While a job runs: the step it is on. */
  progress: { step: string; iteration: number | null; rollout: number | null } | null
  /** A job's agent run; pass it as `turns` to start again from that run. */
  agentTurnId: string | null
  agentRunReset: LearnReset | null
  /** With `judgeInitialAgentRun`: the judgement of the agent run. */
  agentJudgement: { judgementId: string; verdict: string; summary: string | null } | null
  /** Which iteration `code` is from. */
  version: number | null
  iterations: LearnIteration[]
  title: string | null
  /** The task with `{{name}}` placeholders: send it to `session.send()` with `inputs` to run it with the agent. */
  template: string | null
  parameters: LearnParameter[]
  /** `async function main(params = { ... })`. */
  code: string
  outputSchema: Json | null
  validation: { errors: string[]; warnings: string[] }
  /** For `heal`: what changed and why. */
  changes: string | null
  sourceTurns: string[]
  usage: Usage | null
  /** The error code when the request failed, e.g. `trajectory_not_recorded`. */
  error: string | null
  /** True when `idempotencyKey` matched an earlier call: this is that call's result. */
  replayed: boolean
  ok: boolean
  raw: Json
}

function parseLearnReset(v: unknown): LearnReset | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Json
  return {
    kind: str(r.kind) === 'task' ? 'task' : 'code',
    ok: Boolean(r.ok),
    durationMs: typeof r.durationMs === 'number' ? r.durationMs : null,
    turnId: str(r.turnId) ?? null,
    error: str(r.error) ?? null,
  }
}

function parseIteration(d: Json): LearnIteration {
  return {
    index: num(d.index),
    learnId: str(d.learnId) ?? null,
    changes: str(d.changes) ?? null,
    passed: num(d.passed),
    runs: num(d.runs),
    rollouts: (Array.isArray(d.rollouts) ? (d.rollouts as Json[]) : []).map((r) => ({
      index: num(r.index),
      verdict: (str(r.verdict) ?? null) as LearnRollout['verdict'],
      reset: parseLearnReset(r.reset),
      error: str(r.error) ?? null,
      result: (r.result as Json | undefined) ?? null,
      durationMs: typeof r.durationMs === 'number' ? r.durationMs : null,
      judgementId: str(r.judgementId) ?? null,
      summary: str(r.summary) ?? null,
      continuationTurnId: str(r.continuationTurnId) ?? null,
      continuationTimedOut: Boolean(r.continuationTimedOut),
    })),
  }
}

export function parseLearnResult(d: Json): LearnResult {
  const v = obj(d.validation)
  const status = (str(d.status) ?? 'running') as LearnResult['status']
  const mode = str(d.mode)
  const t = d.testResult ? obj(d.testResult) : null
  const p = d.progress ? obj(d.progress) : null
  const aj = d.agentJudgement ? obj(d.agentJudgement) : null
  return {
    id: str(d.learnId) ?? '',
    mode: mode === 'heal' || mode === 'policyIteration' ? mode : 'convert',
    status,
    stopReason: str(d.stopReason) ?? null,
    message: str(d.message) ?? null,
    testResult: t
      ? {
          status: (str(t.status) ?? 'not_judged') as LearnTestResult['status'],
          passedRuns: num(t.passedRuns),
          requiredRuns: num(t.requiredRuns),
          inputs: t.inputs ? (obj(t.inputs) as LearnTestResult['inputs']) : null,
        }
      : null,
    progress: p
      ? {
          step: str(p.step) ?? '',
          iteration: typeof p.iteration === 'number' ? p.iteration : null,
          rollout: typeof p.rollout === 'number' ? p.rollout : null,
        }
      : null,
    agentTurnId: str(d.agentTurnId) ?? null,
    agentRunReset: parseLearnReset(d.agentRunReset),
    agentJudgement: aj
      ? {
          judgementId: str(aj.judgementId) ?? '',
          verdict: str(aj.verdict) ?? '',
          summary: str(aj.summary) ?? null,
        }
      : null,
    version: typeof d.version === 'number' ? d.version : null,
    iterations: (Array.isArray(d.iterations) ? (d.iterations as Json[]) : []).map(parseIteration),
    title: str(d.title) ?? null,
    template: str(d.template) ?? null,
    parameters: (Array.isArray(d.parameters) ? (d.parameters as Json[]) : []).map((p) => ({
      name: str(p.name) ?? '',
      defaultValue: str(p.defaultValue) ?? '',
      description: str(p.description) ?? null,
    })),
    code: str(d.code) ?? '',
    outputSchema: d.outputSchema ? obj(d.outputSchema) : null,
    validation: {
      errors: Array.isArray(v.errors) ? (v.errors as string[]) : [],
      warnings: Array.isArray(v.warnings) ? (v.warnings as string[]) : [],
    },
    changes: str(d.changes) ?? null,
    sourceTurns: Array.isArray(d.sourceTurns) ? (d.sourceTurns as string[]) : [],
    usage: parseUsage(d.usage),
    error: str(d.error) ?? null,
    replayed: Boolean(d.idempotent_replay),
    ok: status === 'succeeded',
    raw: d,
  }
}

/** One run of a learn job's code, from `sai.learn.rollout()`. */
export interface LearnRun {
  learnId: string
  iteration: number
  rollout: number
  /** What the run returned and logged: `{ result, logs, error, durationMs }`. */
  run: Json
  /** The judge's record of the run, when it was judged. */
  judgement: Json | null
  raw: Json
}

export function parseLearnRun(d: Json): LearnRun {
  return {
    learnId: str(d.learnId) ?? '',
    iteration: num(d.iteration),
    rollout: num(d.rollout),
    run: obj(d.run),
    judgement: d.judgement ? obj(d.judgement) : null,
    raw: d,
  }
}

/** The verdict on one criterion of a judgement. */
export interface CriterionResult {
  /** The check's id; null for a natural-language criteria. */
  id: string | null
  check: string
  /** `unverifiable` when the record cannot show it. */
  verdict: 'passed' | 'failed' | 'unverifiable'
  score: number | null
  evidence: string | null
}

/** The result of `sai.judge.create()`. It never changes the turns it judged. Research preview. */
export interface Judgement {
  id: string
  verdict: 'passed' | 'failed' | 'unverifiable' | null
  summary: string | null
  task: string | null
  criteria: CriterionResult[]
  turns: string[]
  usage: Usage | null
  replayed: boolean
  ok: boolean
  raw: Json
}

export function parseJudgement(d: Json): Judgement {
  const verdict = (str(d.verdict) ?? null) as Judgement['verdict']
  return {
    id: str(d.judgementId) ?? '',
    verdict,
    summary: str(d.summary) ?? null,
    task: str(d.task) ?? null,
    criteria: (Array.isArray(d.criteria) ? (d.criteria as Json[]) : []).map((c) => ({
      id: str(c.id) ?? null,
      check: str(c.check) ?? '',
      verdict: (str(c.verdict) ?? 'unverifiable') as CriterionResult['verdict'],
      score: typeof c.score === 'number' ? c.score : null,
      evidence: str(c.evidence) ?? null,
    })),
    turns: Array.isArray(d.turns) ? (d.turns as string[]) : [],
    usage: parseUsage(d.usage),
    replayed: Boolean(d.idempotent_replay),
    ok: verdict === 'passed',
    raw: d,
  }
}
