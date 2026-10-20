import type { Sai } from './client.js'
import { RateLimitError, SaiError } from './errors.js'
import type { Credential, Http } from './http.js'
import {
  parseEnrollment,
  parseTenant,
  parseTenantMachine,
  parseTenantToken,
  type Enrollment,
  type Tenant,
  type TenantMachine,
  type TenantPage,
  type TenantToken,
} from './types.js'

export type TenantRef = Tenant | string
export type TenantMachineRef = TenantMachine | string

/** `tenants.client()` exchanges again when its token has less than this left. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

/** Between machine reads while `tenantMachines.create({ wait: true })` waits. */
const MACHINE_POLL_INTERVAL_MS = 5_000

const q = encodeURIComponent
const tenantPath = (tenant: TenantRef): string =>
  `/v1/tenants/${q(typeof tenant === 'string' ? tenant : tenant.id)}`

/** Tenants: your customers, under an Organisation. Every call takes an Organisation Key. */
export class Tenants {
  constructor(
    private readonly http: Http,
    private readonly orgId: string | undefined,
    private readonly withCredential: (credential: Credential) => Sai,
  ) {}

  /** `externalId` is your id for the customer, unique in the Organisation, and cannot change later. */
  async create(
    name: string,
    opts: { externalId?: string; metadata?: Record<string, string> } = {},
  ): Promise<Tenant> {
    return parseTenant(
      await this.http.json('POST', '/v1/tenants', {
        json: { name, externalId: opts.externalId, metadata: opts.metadata },
      }),
    )
  }

  /**
   * One page, newest first. `externalId` finds the Tenant with that id (zero or one) and
   * cannot be combined with `status`.
   */
  async list(
    opts: { status?: string; externalId?: string; limit?: number; cursor?: string } = {},
  ): Promise<TenantPage> {
    const d = await this.http.json<{ tenants?: Record<string, unknown>[]; nextCursor?: string }>(
      'GET',
      '/v1/tenants',
      { params: opts },
    )
    return { tenants: (d.tenants ?? []).map(parseTenant), nextCursor: d.nextCursor ?? null }
  }

  async get(tenant: TenantRef): Promise<Tenant> {
    return parseTenant(await this.http.json('GET', tenantPath(tenant)))
  }

  /**
   * `metadata` replaces the whole map. `status: 'disabled'` stops the Tenant's tokens and
   * machines; `status: 'active'` brings it back.
   *
   * `cloudMachineLimit` (0 to 1000) caps the Tenant's cloud machines; `null` removes the cap.
   * Lowering it deletes nothing: creates are refused until the count fits. `residentialProxy`
   * is the Tenant's residential proxy switch; it has no effect yet, and traffic goes direct.
   * Only the Organisation Key or an owner may set these two.
   */
  async update(
    tenant: TenantRef,
    opts: {
      name?: string
      metadata?: Record<string, string>
      status?: string
      cloudMachineLimit?: number | null
      residentialProxy?: boolean
    },
  ): Promise<Tenant> {
    return parseTenant(await this.http.json('PATCH', tenantPath(tenant), { json: opts }))
  }

  /**
   * Disables the Tenant and revokes every enrolled machine. Cloud machines stay and hibernate:
   * delete them with `tenantMachines.delete`. Its data is kept: erase it from the console.
   */
  async delete(tenant: TenantRef): Promise<void> {
    await this.http.request('DELETE', tenantPath(tenant))
  }

  /** A single-use code that enrolls one computer into the Tenant. It expires in 15 minutes. */
  async createEnrollment(tenant: TenantRef): Promise<Enrollment> {
    return parseEnrollment(await this.http.json('POST', `${tenantPath(tenant)}/enrollments`))
  }

  /**
   * Exchange the Organisation Key for a one-hour token that acts as the Tenant. `orgId`
   * defaults to the client's `orgId` (`SAI_ORG_ID`).
   */
  async token(tenant: TenantRef, opts: { orgId?: string } = {}): Promise<TenantToken> {
    const orgId = opts.orgId ?? this.orgId
    if (!orgId) {
      throw new Error('No Organisation id: pass orgId here or to new Sai(), or set SAI_ORG_ID.')
    }
    const id = typeof tenant === 'string' ? tenant : tenant.id
    return parseTenantToken(
      await this.http.json('POST', `/v1/orgs/${q(orgId)}/tenants/${q(id)}/token`),
    )
  }

  /**
   * A client that acts as the Tenant. It exchanges a token now, and again before a request
   * when the token has less than five minutes left. Uses this client's Organisation Key.
   */
  async client(tenant: TenantRef, opts: { orgId?: string } = {}): Promise<Sai> {
    let current = await this.token(tenant, opts)
    let pending: Promise<TenantToken> | undefined
    return this.withCredential(async () => {
      if (current.expiresAt - Date.now() >= TOKEN_REFRESH_MARGIN_MS) return current.token
      pending ??= this.token(tenant, opts).finally(() => {
        pending = undefined
      })
      current = await pending
      return current.token
    })
  }
}

/** A Tenant's computers, enrolled and cloud. Every call takes an Organisation Key. */
export class TenantMachines {
  constructor(private readonly http: Http) {}

  /**
   * Create a cloud machine for the Tenant. `os` is `windows` or `linux`; the size follows it.
   * `name` (up to 64 characters) is a label you show your users.
   *
   * `requestId` (letters, digits, `_` and `-`, up to 128) makes a retry safe: the same id and
   * body return the first machine, and the same id with another body throws `ConflictError`
   * (`request_id_reused`). Without one, every call creates a machine.
   *
   * Returns at once with `state: 'provisioning'`. `wait: true` reads the machine until it is
   * `ready`; it throws `SaiError` if the machine fails or is deleted, and a `TimeoutError`
   * (DOMException) after `timeoutMs` (default 10 minutes).
   */
  async create(
    tenant: TenantRef,
    opts: {
      os: 'windows' | 'linux'
      name?: string
      requestId?: string
      wait?: boolean
      timeoutMs?: number
    },
  ): Promise<TenantMachine> {
    let machine = parseTenantMachine(
      await this.http.json('POST', `${tenantPath(tenant)}/machines`, {
        json: { os: opts.os, name: opts.name, requestId: opts.requestId },
      }),
    )
    if (!opts.wait) return machine
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000)
    while (machine.state !== 'ready') {
      if (machine.state === 'failed' || machine.state === 'deleting') {
        throw new SaiError(
          `Cloud machine ${machine.id} is ${machine.state} and will not become ready.`,
          { body: machine.raw },
        )
      }
      if (Date.now() + MACHINE_POLL_INTERVAL_MS > deadline) {
        throw new DOMException(
          `Cloud machine ${machine.id} still ${machine.state}.`,
          'TimeoutError',
        )
      }
      await sleep(MACHINE_POLL_INTERVAL_MS)
      try {
        machine = await this.get(tenant, machine.id)
      } catch (err) {
        if (!(err instanceof RateLimitError)) throw err
        await sleep((err.retryAfter ?? 30) * 1000)
      }
    }
    return machine
  }

  /** Both kinds, enrolled and cloud. A cloud machine is listed from the moment it is created. */
  async list(tenant: TenantRef): Promise<TenantMachine[]> {
    const d = await this.http.json<{ machines?: Record<string, unknown>[] }>(
      'GET',
      `${tenantPath(tenant)}/machines`,
    )
    return (d.machines ?? []).map(parseTenantMachine)
  }

  async get(tenant: TenantRef, machineId: string): Promise<TenantMachine> {
    return parseTenantMachine(
      await this.http.json('GET', `${tenantPath(tenant)}/machines/${q(machineId)}`),
    )
  }

  /**
   * An enrolled machine is signed out at once (`'revoked'`); enroll it again with a new code to
   * bring it back. A cloud machine is deleted with its disk (`'deleting'`), which cannot be
   * undone; it leaves the list when the deletion finishes.
   */
  async delete(tenant: TenantRef, machine: TenantMachineRef): Promise<'revoked' | 'deleting'> {
    const id = typeof machine === 'string' ? machine : machine.id
    const res = await this.http.request('DELETE', `${tenantPath(tenant)}/machines/${q(id)}`)
    return res.status === 202 ? 'deleting' : 'revoked'
  }

  /** `delete` without its answer. On a cloud machine it deletes the machine: use `delete`. */
  async revoke(tenant: TenantRef, machine: TenantMachineRef): Promise<void> {
    await this.delete(tenant, machine)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
