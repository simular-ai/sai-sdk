import { Control } from './control.js'
import { DEFAULT_BASE_URL, Http, type Credential, type FetchLike } from './http.js'
import { Machines } from './machines.js'
import { Sessions } from './sessions.js'
import { TenantMachines, Tenants } from './tenants.js'
import { Turns } from './turns.js'
import { Judge, Learn } from './learn.js'
import {
  parseAccount,
  parseAttachment,
  parseAuthInfo,
  parseModel,
  parseOrgUsage,
  parseSessionSpendPage,
  type Account,
  type Attachment,
  type AuthInfo,
  type Model,
  type OrgUsage,
  type SessionSpendPage,
} from './types.js'
import type { TenantRef } from './tenants.js'

export interface SaiOptions {
  /** Defaults to `process.env.SAI_API_KEY`. */
  apiKey?: string
  /** Defaults to `process.env.SAI_API_URL`, then `https://api.simular.ai`. */
  baseUrl?: string
  /** Per request. Default 60 000. */
  timeoutMs?: number
  versionTag?: string
  /** Replace `fetch`, e.g. in tests. */
  fetch?: FetchLike
  /**
   * The Organisation that `tenants.token()`, `tenants.client()` and `usage` act on. Defaults to
   * `process.env.SAI_ORG_ID`. Only an Organisation Key needs it.
   */
  orgId?: string
}

/**
 * The Sai API client.
 *
 * ```ts
 * const sai = new Sai() // SAI_API_KEY, and SAI_API_URL if set
 * const session = await sai.sessions.create()
 * console.log((await session.run('Open Notepad and type hello')).text)
 * ```
 */
export class Sai {
  readonly machines: Machines
  readonly sessions: Sessions
  readonly turns: Turns
  /** Recorded turns → Simulang code, and code repair (research preview). */
  readonly learn: Learn
  /** Judge recorded turns against new criteria (research preview). */
  readonly judge: Judge
  readonly control: Control
  readonly models: Models
  readonly files: Files
  readonly account: AccountResource
  /** Who the key acts as. */
  readonly auth: Auth
  /** What an Organisation is charged, per Tenant and per session. Takes an Organisation Key. */
  readonly usage: UsageResource
  /** Your customers under an Organisation. Takes an Organisation Key. */
  readonly tenants: Tenants
  /** A Tenant's computers: enrolled, and cloud machines Sai hosts. Takes an Organisation Key. */
  readonly tenantMachines: TenantMachines

  /** @param credential internal: `tenants.client()` passes a token source instead of `apiKey`. */
  constructor(opts: SaiOptions = {}, credential?: Credential) {
    const env = typeof process !== 'undefined' ? process.env : {}
    const key = credential ?? opts.apiKey ?? env.SAI_API_KEY
    if (!key) {
      throw new Error(
        'No API key: pass apiKey or set SAI_API_KEY. Create one at https://platform.simular.ai.',
      )
    }
    const http = new Http(
      key,
      opts.baseUrl ?? env.SAI_API_URL ?? DEFAULT_BASE_URL,
      opts.timeoutMs ?? 60_000,
      opts.versionTag,
      opts.fetch ?? ((input, init) => fetch(input, init)),
    )
    this.machines = new Machines(http)
    this.sessions = new Sessions(http, this.machines)
    this.turns = new Turns(http)
    this.learn = new Learn(http)
    this.judge = new Judge(http)
    this.control = new Control(http)
    this.models = new Models(http)
    this.files = new Files(http)
    this.account = new AccountResource(http)
    this.auth = new Auth(http)
    const orgId = opts.orgId ?? env.SAI_ORG_ID
    this.usage = new UsageResource(http, orgId)
    this.tenants = new Tenants(http, orgId, (c) => new Sai(opts, c))
    this.tenantMachines = new TenantMachines(http)
  }
}

export class Models {
  constructor(private readonly http: Http) {}

  /** Models a session can run on; `allowed` says whether this plan may use each. */
  async list(): Promise<Model[]> {
    const d = await this.http.json<{ models?: Record<string, unknown>[] }>(
      'GET',
      '/v1/agents/models',
    )
    return (d.models ?? []).map(parseModel)
  }
}

export class Files {
  constructor(private readonly http: Http) {}

  /**
   * Upload one file (max 25 MB) to attach to a message. Pass a path (Node), or
   * the bytes with a name.
   */
  async upload(
    file: string | { data: Uint8Array | Blob; name: string },
    opts: { name?: string } = {},
  ): Promise<Attachment> {
    let data: Uint8Array | Blob
    let name: string
    if (typeof file === 'string') {
      const { readFile } = await import('node:fs/promises')
      const { basename } = await import('node:path')
      data = new Uint8Array(await readFile(file))
      name = opts.name ?? basename(file)
    } else {
      data = file.data
      name = opts.name ?? file.name
    }
    const d = await this.http.json<Record<string, unknown>>('POST', '/v1/agents/upload', {
      body: data instanceof Blob ? data : new Blob([data as Uint8Array<ArrayBuffer>]),
      // The server reads only a body that has a Content-Type; it derives the MIME type from the name.
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-filename': encodeURIComponent(name),
      },
      timeoutMs: 120_000,
    })
    return parseAttachment(d)
  }
}

export class AccountResource {
  constructor(private readonly http: Http) {}

  /** Plan and spendable credit. Slow-ish (billing lookup): not for a poll loop. */
  async get(): Promise<Account> {
    return parseAccount(await this.http.json('GET', '/v1/agents/account'))
  }
}

export class Auth {
  constructor(private readonly http: Http) {}

  /** Who the key or token acts as. Throws `AuthenticationError` for a missing or revoked key. */
  async check(): Promise<AuthInfo> {
    return parseAuthInfo(await this.http.json('GET', '/v1/agents/auth'))
  }
}

export class UsageResource {
  constructor(
    private readonly http: Http,
    private readonly orgId: string | undefined,
  ) {}

  /**
   * What the Organisation is charged, in total and per Tenant, per `granularity` (`hour`, `day`
   * or `month`; default `day`) from `from` to `to`: `2026-10` for a month, `2026-10-15` for a
   * day, `2026-10-15T09` for an hour. Each defaults to a range that ends now.
   */
  async get(
    opts: { granularity?: string; from?: string; to?: string; orgId?: string } = {},
  ): Promise<OrgUsage> {
    const { orgId, ...params } = opts
    return parseOrgUsage(
      await this.http.json('GET', `/v1/orgs/${encodeURIComponent(this.#org(orgId))}/usage`, {
        params,
      }),
    )
  }

  /**
   * One page of what each of a Tenant's sessions spent on AI calls, oldest first, for the UTC
   * days `from` to `to` (`YYYY-MM-DD`, both included, at most 93 days). Keep paging with
   * `nextCursor` until it is null: a page can be empty and not be the last.
   *
   * With `sessionIds` (1 to 50) instead of the range, the named sessions' spend right now, each
   * with `settled`, and the page's `asOf`; no paging. Charge for a task once its session is
   * settled.
   */
  async sessions(
    tenant: TenantRef,
    opts: {
      from?: string
      to?: string
      limit?: number
      cursor?: string
      sessionIds?: string[]
      orgId?: string
    },
  ): Promise<SessionSpendPage> {
    const { orgId, sessionIds, ...rest } = opts
    const tenantId = typeof tenant === 'string' ? tenant : tenant.id
    return parseSessionSpendPage(
      await this.http.json(
        'GET',
        `/v1/orgs/${encodeURIComponent(this.#org(orgId))}/usage/sessions`,
        {
          params: {
            tenantId,
            ...rest,
            sessionIds: sessionIds?.length ? sessionIds.join(',') : undefined,
          },
        },
      ),
    )
  }

  #org(orgId: string | undefined): string {
    const id = orgId ?? this.orgId
    if (!id)
      throw new Error('No Organisation id: pass orgId here or to new Sai(), or set SAI_ORG_ID.')
    return id
  }
}
