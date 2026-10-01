/**
 * The Sai task view for hosts that can't render MCP Apps (Claude Code, Codex
 * CLI): the same page, served from this process on 127.0.0.1, linked from
 * `sai_task_start` as `watch_url`. The page calls the same app-only tools over
 * `POST /tool` instead of the host's postMessage bridge, so the API key stays in
 * this process and the browser needs no login.
 *
 * Guards, since any local page can try to reach a localhost port:
 * - bound to 127.0.0.1 on a random port;
 * - every request carries this process's random token (constant-time compare);
 * - Host must be this listener (defeats DNS rebinding) and a `POST` must come
 *   from this origin with a JSON body (a cross-site form or no-cors fetch can't).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { LIVE_ORIGINS } from './app-view.js'

/** The only tools the page may call. */
export const LOCAL_VIEW_TOOLS = [
  'sai_view_poll',
  'sai_view_live',
  'sai_view_save',
  'sai_task_approve',
] as const
export type LocalViewTool = (typeof LOCAL_VIEW_TOOLS)[number]

// A saved view carries the last screen frame (see app-view.ts saveArgs).
const MAX_BODY = 2 * 1024 * 1024

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  `connect-src 'self' ${LIVE_ORIGINS.join(' ')}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

export class LocalView {
  private readonly token = randomBytes(24).toString('hex')
  private listening?: Promise<number>

  constructor(
    private readonly deps: {
      html: () => string
      call: (name: LocalViewTool, args: Record<string, unknown>) => Promise<CallToolResult>
      log: (line: string) => void
    },
  ) {}

  /** The page for one task; starts the listener on first use. */
  async urlFor(sessionId: string, machineId: string, taskId: string): Promise<string> {
    const port = await this.port()
    const q = new URLSearchParams({ s: sessionId, m: machineId, k: taskId, t: this.token })
    return `http://127.0.0.1:${port}/task?${q}`
  }

  private port(): Promise<number> {
    this.listening ??= new Promise((resolve, reject) => {
      const server: Server = createServer((req, res) => {
        this.handle(req, res, (server.address() as AddressInfo).port).catch((err: unknown) => {
          this.deps.log(`local view: ${err instanceof Error ? err.message : String(err)}`)
          if (!res.headersSent) send(res, 500, 'text/plain', 'Internal error')
        })
      })
      server.once('error', (err) => {
        this.listening = undefined
        reject(err)
      })
      server.listen(0, '127.0.0.1', () => {
        // Never keep the MCP process alive just for the page.
        server.unref()
        resolve((server.address() as AddressInfo).port)
      })
    })
    return this.listening
  }

  private tokenOk(given: string | null | undefined): boolean {
    if (!given) return false
    const a = Buffer.from(given)
    const b = Buffer.from(this.token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  private async handle(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
    const origin = `http://127.0.0.1:${port}`
    if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 421, 'text/plain', 'Wrong host')
    const url = new URL(req.url ?? '/', origin)

    if (req.method === 'GET' && url.pathname === '/task') {
      if (!this.tokenOk(url.searchParams.get('t'))) return send(res, 403, 'text/plain', 'Forbidden')
      return send(res, 200, 'text/html; charset=utf-8', this.deps.html(), {
        'Content-Security-Policy': CSP,
      })
    }

    if (req.method === 'POST' && url.pathname === '/tool') {
      const token = req.headers['x-sai-token']
      if (req.headers.origin !== origin || !this.tokenOk(typeof token === 'string' ? token : null))
        return send(res, 403, 'text/plain', 'Forbidden')
      if (!String(req.headers['content-type']).startsWith('application/json'))
        return send(res, 415, 'text/plain', 'JSON only')
      const body = await readBody(req)
      if (body === null) return send(res, 413, 'text/plain', 'Too large')
      let parsed: { name?: unknown; arguments?: unknown }
      try {
        parsed = JSON.parse(body) as typeof parsed
      } catch {
        return send(res, 400, 'text/plain', 'Bad JSON')
      }
      const name = parsed.name
      if (typeof name !== 'string' || !(LOCAL_VIEW_TOOLS as readonly string[]).includes(name))
        return send(res, 404, 'text/plain', 'Unknown tool')
      const args =
        parsed.arguments && typeof parsed.arguments === 'object'
          ? (parsed.arguments as Record<string, unknown>)
          : {}
      const result = await this.deps.call(name as LocalViewTool, args)
      return send(res, 200, 'application/json', JSON.stringify(result))
    }

    send(res, 404, 'text/plain', 'Not found')
  }
}

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    // The page URL carries the token: never leak it in a Referer.
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...extra,
  })
  res.end(body)
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
