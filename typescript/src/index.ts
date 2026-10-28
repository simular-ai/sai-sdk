/**
 * TypeScript SDK for the Sai API.
 *
 * - `sai.sessions`: give Sai a task on a computer and get the answer back.
 * - `sai.learn`, `sai.judge`: turn recorded turns or a task into Simulang code, repair it, run
 *   judge and repair it on a machine (policy iteration), judge turns.
 * - `sai.control`: drive a cloud computer yourself with Simulang.
 * - `sai.machines`, `sai.models`, `sai.files`, `sai.account`.
 * - `sai.tenants`, `sai.tenantMachines`: your customers under an Organisation (an Organisation Key).
 */

export { Sai, type SaiOptions } from './client.js'
export {
  AuthenticationError,
  BadRequestError,
  BlockError,
  ConflictError,
  ConnectionError,
  GoneError,
  LinkOnlyApprovalError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  SaiError,
  ServiceUnavailableError,
  SpendCapReachedError,
} from './errors.js'
export { ControlLease } from './control.js'
export type { MachineRef } from './machines.js'
export type { TenantMachineRef, TenantRef } from './tenants.js'
export type { TurnRef } from './turns.js'
export type { JudgeOptions, LearnOptions } from './learn.js'
export {
  Session,
  Turn,
  type ApprovalAnswer,
  type ApprovalHandler,
  type SendOptions,
  type ThinkingLevel,
  type WaitOptions,
} from './sessions.js'
export {
  EVENT_KINDS,
  TURN_RECORD_STATUSES,
  TURN_STATUSES,
  type Account,
  type Approval,
  type Attachment,
  type Check,
  type CriterionResult,
  type Enrollment,
  type Evaluation,
  type Event,
  type Evidence,
  type EventKind,
  type ExecError,
  type ExecResult,
  type Judgement,
  type LearnIteration,
  type LearnParameter,
  type LearnReset,
  type LearnResult,
  type LearnRollout,
  type LearnRun,
  type LearnTestResult,
  type LiveView,
  type Machine,
  type Model,
  type Tenant,
  type TenantMachine,
  type TenantPage,
  type TenantToken,
  type TrajectoryStep,
  type TurnRecord,
  type TurnRecordStatus,
  type TurnResult,
  type TurnStatus,
  type Usage,
} from './types.js'
export { VERSION } from './version.js'
