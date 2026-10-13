/**
 * TypeScript SDK for the Sai API.
 *
 * - `sai.sessions`: give Sai a task on a computer and get the answer back.
 * - `sai.control`: drive a cloud computer yourself with Simulang.
 * - `sai.machines`, `sai.models`, `sai.files`, `sai.account`.
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
} from './errors.js'
export { ControlLease } from './control.js'
export type { MachineRef } from './machines.js'
export {
  Session,
  Turn,
  type ApprovalAnswer,
  type ApprovalHandler,
  type SendOptions,
  type WaitOptions,
} from './sessions.js'
export {
  EVENT_KINDS,
  TURN_STATUSES,
  type Account,
  type Approval,
  type Attachment,
  type Event,
  type EventKind,
  type ExecError,
  type ExecResult,
  type LiveView,
  type Machine,
  type Model,
  type TurnResult,
  type TurnStatus,
  type Usage,
} from './types.js'
export { VERSION } from './version.js'
