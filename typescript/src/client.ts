import { Control } from './control.js'
import { DEFAULT_BASE_URL, Http, type FetchLike } from './http.js'
import { Machines } from './machines.js'
import { Sessions } from './sessions.js'
import {
  parseAccount,
  parseAttachment,
  parseModel,
  type Account,
  type Attachment,
  type Model,
} from './types.js'

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
  readonly control: Control
  readonly models: Models
  readonly files: Files
  readonly account: AccountResource

  constructor(opts: SaiOptions = {}) {
    const env = typeof process !== 'undefined' ? process.env : {}
    const key = opts.apiKey ?? env.SAI_API_KEY
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
    this.control = new Control(http)
    this.models = new Models(http)
    this.files = new Files(http)
    this.account = new AccountResource(http)
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
      headers: { 'x-filename': encodeURIComponent(name) },
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
