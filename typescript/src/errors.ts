/**
 * A non-2xx response from the Sai API. `code` is the machine-readable `error`
 * string when the server sent one (`machine_busy`, `link_only`, ...); `message`
 * is the human text; `body` is the parsed JSON body, unchanged.
 */
export class SaiError extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly body: Record<string, unknown>
  readonly retryAfter: number | undefined

  constructor(
    message: string,
    opts: {
      status?: number
      code?: string
      body?: Record<string, unknown>
      retryAfter?: number
      cause?: unknown
    } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = new.target.name
    this.status = opts.status ?? 0
    this.code = opts.code
    this.body = opts.body ?? {}
    this.retryAfter = opts.retryAfter
  }
}

/** The API could not be reached (DNS, TLS, timeout). */
export class ConnectionError extends SaiError {}
/** 400: the request was invalid, e.g. several computers and no `machine`. */
export class BadRequestError extends SaiError {}
/** 401: no key, or the key is unknown or revoked. */
export class AuthenticationError extends SaiError {}
/** 403: the key is valid but the account may not do this (plan, ownership). */
export class PermissionDeniedError extends SaiError {}
/** 404. */
export class NotFoundError extends SaiError {}
/** 409: e.g. `machine_busy`, `link_only`, approval no longer pending. */
export class ConflictError extends SaiError {}
/**
 * 410 `control_closed`: the control lease has ended (closed, sat idle, lost
 * the computer to a Sai task, or the computer stopped answering). `body.reason`
 * says which. Open a new one.
 */
export class GoneError extends SaiError {}
/** 429: a rate limit, or a free-plan budget that resets daily. */
export class RateLimitError extends SaiError {}
/** 503: the computer did not come online, or no capacity. Honor `retryAfter`. */
export class ServiceUnavailableError extends SaiError {}

/**
 * A control helper's Simulang block failed on the computer. `kind` is
 * `exception`, `timeout` or `interrupted`.
 */
export class BlockError extends SaiError {
  readonly kind: string
  constructor(kind: string, message: string) {
    super(`${kind}: ${message}`, { code: kind })
    this.kind = kind
  }
}

/** The approval must be answered by a human in a browser: open `approvalUrl`. */
export class LinkOnlyApprovalError extends ConflictError {
  get approvalUrl(): string | undefined {
    const url = this.body.approvalUrl
    return typeof url === 'string' ? url : undefined
  }
}

/**
 * 403 `spend_cap_reached`: the key reached its monthly spend limit, or (on a
 * cloud machine create, `body.scope === 'tenant'`) the Tenant reached its budget. Not
 * retryable: the limit resets at `resetsAt` (ISO 8601, 00:00 UTC on the 1st),
 * or raise it for the key in the portal.
 */
export class SpendCapReachedError extends PermissionDeniedError {
  get resetsAt(): string | undefined {
    const at = this.body.resetsAt
    return typeof at === 'string' ? at : undefined
  }
}

const BY_CODE: Partial<Record<string, typeof SaiError>> = {
  link_only: LinkOnlyApprovalError,
  spend_cap_reached: SpendCapReachedError,
}

const BY_STATUS: Record<number, typeof SaiError> = {
  400: BadRequestError,
  401: AuthenticationError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  410: GoneError,
  429: RateLimitError,
  503: ServiceUnavailableError,
}

export function errorFor(
  status: number,
  body: Record<string, unknown>,
  retryAfter: number | undefined,
): SaiError {
  const err = body.error
  const detail = body.message
  // Two body shapes: `{ error: "<human text>" }` (/v1/agents) and
  // `{ error: "<code>", message: "<human text>" }` (/v1/machines/{id}/control, newer errors).
  const code =
    typeof err === 'string' && (detail !== undefined || looksLikeCode(err)) ? err : undefined
  let message =
    typeof detail === 'string' ? detail : typeof err === 'string' ? err : `HTTP ${status}`
  if (status === 401) message += ' (SAI_API_KEY was rejected: it may be revoked.)'
  const Cls =
    (code !== undefined && Object.hasOwn(BY_CODE, code) ? BY_CODE[code] : undefined) ??
    BY_STATUS[status] ??
    SaiError
  // The `Retry-After` header wins; `retryAfterSeconds` is the same value in the body (`rate_limited`).
  const wait =
    retryAfter ?? (typeof body.retryAfterSeconds === 'number' ? body.retryAfterSeconds : undefined)
  return new Cls(message, { status, code, body, retryAfter: wait })
}

function looksLikeCode(s: string): boolean {
  return s.length > 0 && !s.includes(' ') && s === s.toLowerCase()
}
