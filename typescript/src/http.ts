import { ConnectionError, errorFor, type SaiError } from './errors.js'
import { VERSION } from './version.js'

export const DEFAULT_BASE_URL = 'https://api.simular.ai'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** The bearer token, or a function that returns it before each request. */
export type Credential = string | (() => Promise<string>)

export interface RequestOptions {
  json?: unknown
  params?: Record<string, string | number | undefined>
  body?: BodyInit
  headers?: Record<string, string>
  timeoutMs?: number
}

/** The one place requests are made: auth header, error mapping, timeouts. */
export class Http {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>

  constructor(
    private readonly credential: Credential,
    baseUrl: string,
    private readonly timeoutMs: number,
    versionTag: string | undefined,
    private readonly fetchImpl: FetchLike,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.headers = { 'User-Agent': `sai-typescript/${VERSION}` }
    if (typeof credential === 'string') this.headers.Authorization = `Bearer ${credential}`
    // routes the request to a tagged API revision
    if (versionTag) this.headers['x-sai-version'] = versionTag
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const url = new URL(this.baseUrl + path)
    for (const [k, v] of Object.entries(opts.params ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }
    const headers = { ...this.headers, ...opts.headers }
    if (typeof this.credential === 'function') {
      headers.Authorization = `Bearer ${await this.credential()}`
    }
    let body = opts.body
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(opts.json)
    }
    let res: Response
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
      })
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ConnectionError(`Request to ${url.host} timed out.`, { cause: err })
      }
      const cause =
        err instanceof Error ? (err.cause as { message?: string } | undefined) : undefined
      const detail = cause?.message ?? (err instanceof Error ? err.message : String(err))
      throw new ConnectionError(
        `Could not reach the Sai API at ${url.host}: ${detail}. Check the network and SAI_API_URL.`,
        { cause: err },
      )
    }
    if (res.status >= 400) throw await toError(res)
    return res
  }

  async json<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.request(method, path, opts)
    const text = await res.text()
    return (text ? JSON.parse(text) : null) as T
  }
}

async function toError(res: Response): Promise<SaiError> {
  const text = await res.text().catch(() => '')
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    body =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { error: String(parsed) }
  } catch {
    body = { error: text.slice(0, 500) || res.statusText }
  }
  const raw = res.headers.get('retry-after')
  const retryAfter =
    raw !== null && raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : undefined
  return errorFor(res.status, body, retryAfter)
}
