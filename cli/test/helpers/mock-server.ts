import { createServer } from 'http'
import type { IncomingMessage, Server, ServerResponse } from 'http'

export interface MockRequest {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body: string
}

export interface MockResponse {
  status?: number
  headers?: Record<string, string>
  body: string | object
  sse?: boolean
}

type Handler = (req: MockRequest) => MockResponse | Promise<MockResponse>

export interface MockServer {
  url: string
  on: (method: string, path: string, handler: Handler) => void
  close: () => Promise<void>
}

function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

function parseQuery(search: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!search) return out
  const params = new URLSearchParams(search)
  params.forEach((v, k) => {
    out[k] = v
  })
  return out
}

export async function startMockServer(): Promise<MockServer> {
  const routes = new Map<string, Handler>()

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const rawUrl = req.url ?? '/'
    const qIdx = rawUrl.indexOf('?')
    const path = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl
    const query = qIdx >= 0 ? parseQuery(rawUrl.slice(qIdx + 1)) : {}
    const key = `${req.method} ${path}`
    const body = await collectBody(req)

    const handler = routes.get(key)

    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `No mock registered for ${key}` }))
      return
    }

    const mockReq: MockRequest = {
      method: req.method ?? 'GET',
      path,
      query,
      headers: req.headers as Record<string, string>,
      body,
    }

    try {
      const response = await handler(mockReq)
      const status = response.status ?? 200

      if (response.sse) {
        res.writeHead(status, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          ...(response.headers ?? {}),
        })
        const bodyStr =
          typeof response.body === 'string' ? response.body : JSON.stringify(response.body)
        res.write(bodyStr)
        res.end()
      } else {
        const bodyStr =
          typeof response.body === 'string' ? response.body : JSON.stringify(response.body)
        res.writeHead(status, {
          'Content-Type': 'application/json',
          ...(response.headers ?? {}),
        })
        res.end(bodyStr)
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(err) }))
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as { port: number }

  return {
    url: `http://127.0.0.1:${addr.port}`,
    on(method: string, path: string, handler: Handler) {
      routes.set(`${method} ${path}`, handler)
    },
    close() {
      return new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      )
    },
  }
}

/** Builds an SSE body string from an array of event objects. */
export function makeSseBody(...events: object[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
}
