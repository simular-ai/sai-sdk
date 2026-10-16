import type { Sai } from './client.js'
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
   */
  async update(
    tenant: TenantRef,
    opts: { name?: string; metadata?: Record<string, string>; status?: string },
  ): Promise<Tenant> {
    return parseTenant(await this.http.json('PATCH', tenantPath(tenant), { json: opts }))
  }

  /** Disables the Tenant and revokes every machine. Its data is kept: erase it from the console. */
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

/** A Tenant's enrolled computers. Every call takes an Organisation Key. */
export class TenantMachines {
  constructor(private readonly http: Http) {}

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

  /** Signs the machine out at once. To bring it back, enroll it again with a new code. */
  async revoke(tenant: TenantRef, machine: TenantMachineRef): Promise<void> {
    const id = typeof machine === 'string' ? machine : machine.id
    await this.http.request('DELETE', `${tenantPath(tenant)}/machines/${q(id)}`)
  }
}
