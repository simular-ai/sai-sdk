/**
 * Integration / scenario tests for the sai CLI.
 *
 * Each test spawns `tsx src/cli.ts` as a real subprocess with:
 *   - A temp HOME directory (isolated ~/.simular/cli state)
 *   - SAI_API_URL pointing to a lightweight in-process mock HTTP server
 *
 * This validates the full CLI flow without requiring a live cloud-api or Firebase
 * instance. To test against a real local cloud-api instead, set:
 *   SAI_API_URL=http://localhost:8080 npm test -- --project=sai-cli
 *
 * Token auto-refresh (near-expiry idToken) is covered by unit tests in
 * auth/__tests__/token-store.test.ts; the securetoken endpoint is hardcoded to
 * googleapis.com and cannot be redirected via SAI_API_URL.
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { tmpdir } from 'os'
import { createServer } from 'http'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_PATH = resolve(__dirname, '../../cli.ts')

// Captured by the vi.mock factory via closure so each test's CLI_DIR resolves
// to the temp homeDir created in beforeEach (same pattern as token-store unit tests).
let HOMEDIR_FOR_CREDS = ''
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => HOMEDIR_FOR_CREDS }
})

let tokenStore: typeof import('../../auth/token-store.js')

interface SpawnResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface SpawnOptions {
  apiUrl: string
  homeDir: string
  stdinLines?: string[]
  timeout?: number
}

function spawnCli(args: string[], opts: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    // Run the TS CLI via `node --import tsx` instead of the node_modules/.bin/tsx
    // shim: the extensionless shim is not directly spawnable on Windows.
    const proc = spawn(process.execPath, ['--import', 'tsx', CLI_PATH, ...args], {
      env: {
        ...process.env,
        // os.homedir() reads HOME on POSIX and USERPROFILE on Windows — set both
        // so the child's ~/.simular/cli resolves to the test's temp dir on every platform.
        HOME: opts.homeDir,
        USERPROFILE: opts.homeDir,
        SAI_API_URL: opts.apiUrl,
      },
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    if (opts.stdinLines && opts.stdinLines.length > 0) {
      for (const line of opts.stdinLines) {
        proc.stdin.write(`${line}\n`)
      }
    }
    proc.stdin.end()

    const timeoutMs = opts.timeout ?? 15_000
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(
        new Error(
          `CLI subprocess timed out after ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`,
        ),
      )
    }, timeoutMs)

    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code ?? 1 })
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

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

function collectBody(req: import('http').IncomingMessage): Promise<string> {
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

async function startMockServer(): Promise<MockServer> {
  const routes = new Map<string, Handler>()

  const server = createServer(async (req, res) => {
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

function makeSseBody(...events: object[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// writeCreds and writeSession call the real token-store functions (whose CLI_DIR
// is set to homeDir via the vi.mock('os') + vi.resetModules() pattern in beforeEach).
// This ensures the encrypted .mk/.rt files are created alongside credentials.json
// so loadCredentials() in the spawned subprocess can find the refresh token.

function writeCreds(overrides: { sessionTimeoutMs?: number } = {}): void {
  tokenStore.saveCredentials({
    firebaseIdToken: 'test-id-token',
    refreshToken: 'test-refresh-token',
    idTokenExpiresIn: 3600,
    email: 'test@example.com',
    userId: 'test-uid',
    ...overrides,
  })
}

function writeSession(machineId: string): void {
  tokenStore.saveSession({ machineId })
}

function readSession(homeDir: string): { machineId: string } {
  return JSON.parse(readFileSync(join(homeDir, '.simular', 'cli', 'session.json'), 'utf-8'))
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('sai CLI integration', { timeout: 20_000 }, () => {
  let server: MockServer
  let homeDir: string

  beforeEach(async () => {
    server = await startMockServer()
    // Default empty concierge side track — the CLI polls this in parallel with
    // /message. Without a handler the poll 404s (harmless) but can race
    // process shutdown on Windows; return an empty feed instead.
    server.on('GET', '/v1/cli/concierge-messages', () => ({
      body: { sessionId: 'test-session', messages: [] },
    }))
    homeDir = mkdtempSync(join(tmpdir(), 'sai-int-'))
    HOMEDIR_FOR_CREDS = homeDir
    vi.resetModules()
    tokenStore = await import('../../auth/token-store.js')
  })

  afterEach(async () => {
    await server.close()
    rmSync(homeDir, { recursive: true, force: true })
  })

  // ─── Auth guard ─────────────────────────────────────────────────────────────

  it('not authenticated: exits 1 with "Not authenticated" on stderr', async () => {
    const result = await spawnCli(['-m', 'say hello'], { apiUrl: server.url, homeDir })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Not authenticated')
  })

  it('session expired: exits 1 with "Session expired" on stderr', async () => {
    writeCreds({ sessionTimeoutMs: -1_000 })
    const result = await spawnCli(['-m', 'say hello'], { apiUrl: server.url, homeDir })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Session expired')
  })

  // ─── Machine selection ───────────────────────────────────────────────────────

  it('no machines: exits 1 with "No machines found" on stderr', async () => {
    writeCreds()
    server.on('GET', '/v1/agents/machines', () => ({
      body: { machines: [] },
    }))

    const result = await spawnCli(['-m', 'say hello'], { apiUrl: server.url, homeDir })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('No machines found')
  })

  it('single machine: auto-selects and prints "Using: <name>"', async () => {
    writeCreds()
    server.on('GET', '/v1/agents/machines', () => ({
      body: { machines: [{ machineId: 'm1', name: 'My MacBook', updatedAt: Date.now() }] },
    }))
    server.on('POST', '/v1/cli/message', () => ({
      sse: true,
      body: makeSseBody(
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Done!' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: 'stop' },
      ),
    }))

    const result = await spawnCli(['-m', 'hello Sai'], { apiUrl: server.url, homeDir })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Using: My MacBook')
    expect(result.stdout).toContain('Done!')
    // session.json should be saved
    expect(readSession(homeDir).machineId).toBe('m1')
  })

  it('multiple machines with no session: exits and asks user to run sai machine', async () => {
    writeCreds()
    server.on('GET', '/v1/agents/machines', () => ({
      body: {
        machines: [
          { machineId: 'm1', name: 'Work Laptop', updatedAt: Date.now() },
          { machineId: 'm2', name: 'Home Desktop', updatedAt: Date.now() - 86_400_000 },
        ],
      },
    }))

    const result = await spawnCli(['-m', 'do a task'], { apiUrl: server.url, homeDir })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('sai machine')
  })

  it('sai machine: auto-selects single machine and saves session.json', async () => {
    writeCreds()
    server.on('GET', '/v1/agents/machines', () => ({
      body: { machines: [{ machineId: 'mac-abc', name: 'My Mac', updatedAt: Date.now() }] },
    }))

    const result = await spawnCli(['machine'], { apiUrl: server.url, homeDir })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Selected: My Mac')
    expect(readSession(homeDir).machineId).toBe('mac-abc')
  })

  it('sai machine: prompts when multiple machines exist', async () => {
    writeCreds()
    server.on('GET', '/v1/agents/machines', () => ({
      body: {
        machines: [
          { machineId: 'mac-1', name: 'Office Mac', updatedAt: Date.now() },
          { machineId: 'mac-2', name: 'Home Mac', updatedAt: Date.now() - 3_600_000 },
        ],
      },
    }))

    // stdin "1\n" selects the first machine
    const result = await spawnCli(['machine'], { apiUrl: server.url, homeDir, stdinLines: ['1'] })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Selected: Office Mac')
    expect(readSession(homeDir).machineId).toBe('mac-1')
  })

  // ─── Message send ────────────────────────────────────────────────────────────

  it('happy path: streams chunks to stdout, exits 0', async () => {
    writeCreds()
    writeSession('machine-1')
    server.on('POST', '/v1/cli/message', () => ({
      sse: true,
      body: makeSseBody(
        { type: 'data-status', data: { text: 'Working on it...' } },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Found 3 emails.' },
        { type: 'text-end', id: 't1' },
        { type: 'text-start', id: 't2' },
        { type: 'text-delta', id: 't2', delta: 'All done.' },
        { type: 'text-end', id: 't2' },
        { type: 'finish', finishReason: 'stop' },
      ),
    }))

    const result = await spawnCli(['-m', 'check my email'], { apiUrl: server.url, homeDir })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Found 3 emails.')
    expect(result.stdout).toContain('All done.')
  })

  it('displays Sai response chunks on stdout and status updates on stderr', async () => {
    writeCreds()
    writeSession('machine-1')
    server.on('POST', '/v1/cli/message', () => ({
      sse: true,
      body: makeSseBody(
        { type: 'data-status', data: { text: 'Opening Gmail...' } },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Action item 1: Reply to Alex.' },
        { type: 'text-end', id: 't1' },
        { type: 'text-start', id: 't2' },
        { type: 'text-delta', id: 't2', delta: 'Action item 2: Submit expense report.' },
        { type: 'text-end', id: 't2' },
        { type: 'finish', finishReason: 'stop' },
      ),
    }))

    const result = await spawnCli(['-m', 'list my action items'], { apiUrl: server.url, homeDir })

    expect(result.exitCode).toBe(0)

    // Both chunks appear on stdout
    expect(result.stdout).toContain('Action item 1: Reply to Alex.')
    expect(result.stdout).toContain('Action item 2: Submit expense report.')

    // Status event goes to stderr, not stdout
    expect(result.stderr).toContain('Opening Gmail...')
    expect(result.stdout).not.toContain('Opening Gmail...')

    // Chunk text stays off stderr
    expect(result.stderr).not.toContain('Action item 1')
    expect(result.stderr).not.toContain('Action item 2')
  })

  it('Sai error event: prints error text on stderr, exits 1', async () => {
    writeCreds()
    writeSession('machine-1')
    server.on('POST', '/v1/cli/message', () => ({
      sse: true,
      body: makeSseBody({
        type: 'error',
        errorText:
          'Timed out waiting for Sai to respond. The task may still be running — check the desktop app.',
      }),
    }))

    const result = await spawnCli(['-m', 'do something slow'], { apiUrl: server.url, homeDir })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Timed out waiting for Sai')
  })

  it('sai new: calls /new-session and prints confirmation', async () => {
    writeCreds()
    writeSession('machine-1')
    server.on('POST', '/v1/agents/new-session', () => ({
      body: { sessionId: 'sess-abc123' },
    }))

    const result = await spawnCli(['new'], { apiUrl: server.url, homeDir })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('sess-abc123')
  })

  // ─── File upload ─────────────────────────────────────────────────────────────

  it('multiple -f flags: uploads all files and includes them as attachments', async () => {
    writeCreds()
    writeSession('machine-1')

    const file1 = join(homeDir, 'a.txt')
    const file2 = join(homeDir, 'b.txt')
    writeFileSync(file1, 'hello')
    writeFileSync(file2, 'world')

    const uploadedNames: string[] = []
    server.on('POST', '/v1/agents/upload', (req) => {
      uploadedNames.push(decodeURIComponent(req.headers['x-filename'] ?? ''))
      return {
        body: {
          path: `uploads/${req.headers['x-filename']}`,
          name: decodeURIComponent(req.headers['x-filename'] ?? ''),
          mime: 'text/plain',
          size: 5,
          downloadUrl: 'https://storage.example.com/file',
        },
      }
    })

    let capturedBody = ''
    server.on('POST', '/v1/cli/message', (req) => {
      capturedBody = req.body
      return {
        sse: true,
        body: makeSseBody(
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Files processed.' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: 'stop' },
        ),
      }
    })

    const result = await spawnCli(['-f', file1, '-f', file2, '-m', 'process these files'], {
      apiUrl: server.url,
      homeDir,
    })
    expect(result.exitCode).toBe(0)
    expect(uploadedNames).toHaveLength(2)
    const body = JSON.parse(capturedBody) as { attachments?: unknown[] }
    expect(body.attachments).toHaveLength(2)
    expect(result.stdout).toContain('Files processed.')
  })

  // ─── Command argument parsing ─────────────────────────────────────────────────

  it('no arguments: prints help and exits 0', async () => {
    const result = await spawnCli([], { apiUrl: server.url, homeDir })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('sai')
    // Help should list top-level commands
    expect(result.stdout).toContain('login')
    expect(result.stdout).toContain('machine')
  })

  it('positional message (bare multi-word): exits 1 and points to --message', async () => {
    writeCreds()
    writeSession('machine-1')
    // spawnCli(['open', 'Chrome']) passes two separate argv tokens — same as: sai open Chrome
    const result = await spawnCli(['open', 'Chrome'], { apiUrl: server.url, homeDir })
    expect(result.exitCode).toBe(1)
    // Not accepted positionally — must guide the user to -m.
    expect(result.stderr).toContain('--message')
    expect(result.stderr).toContain('sai -m open Chrome')
    // Still lists valid commands so users know what's available
    expect(result.stderr).toContain('login')
    expect(result.stderr).toContain('machine')
  })

  it('positional message (single bare word): exits 1 and points to --message', async () => {
    writeCreds()
    writeSession('machine-1')
    // `sai hi` — a single word is not a command and isn't a positional message.
    const result = await spawnCli(['hi'], { apiUrl: server.url, homeDir })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('sai -m hi')
    expect(result.stderr).toContain('--message')
  })

  it('retired `sai resume`: exits 1 with the dedicated-session explanation, not the -m hint', async () => {
    writeCreds()
    writeSession('machine-1')
    const result = await spawnCli(['resume', 'abc123'], { apiUrl: server.url, homeDir })
    expect(result.exitCode).toBe(1)
    // Explains the removal and points at the replacement...
    expect(result.stderr).toContain('sai resume was removed')
    expect(result.stderr).toContain('sai new')
    // ...and does NOT misdirect the user into re-sending it as a task.
    expect(result.stderr).not.toContain('sai -m resume')
  })

  it('--message: sends a multi-word message without quoting', async () => {
    writeCreds()
    writeSession('machine-1')
    let capturedBody = ''
    server.on('POST', '/v1/cli/message', (req) => {
      capturedBody = req.body
      return {
        sse: true,
        body: makeSseBody(
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Done!' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: 'stop' },
        ),
      }
    })

    // -m is variadic: the separate tokens are joined into one message.
    const result = await spawnCli(['-m', 'open', 'the', 'app'], { apiUrl: server.url, homeDir })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Done!')
    const body = JSON.parse(capturedBody) as { message: string }
    expect(body.message).toBe('open the app')
  })

  it('--message: a single word that matches a command name is sent as a message', async () => {
    writeCreds()
    writeSession('machine-1')
    let capturedBody = ''
    server.on('POST', '/v1/cli/message', (req) => {
      capturedBody = req.body
      return {
        sse: true,
        body: makeSseBody(
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'ok' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: 'stop' },
        ),
      }
    })

    // `sai -m login` must send "login" as a message, NOT run the login command.
    const result = await spawnCli(['-m', 'login'], { apiUrl: server.url, homeDir })
    expect(result.exitCode).toBe(0)
    const body = JSON.parse(capturedBody) as { message: string }
    expect(body.message).toBe('login')
  })

  // ─── Verbosity tiers ─────────────────────────────────────────────────────────

  it('default (no flag, level 1): narrations shown; tool_call and progress suppressed', async () => {
    writeCreds()
    writeSession('machine-1')
    server.on('POST', '/v1/cli/message', () => ({
      sse: true,
      body: makeSseBody(
        { type: 'reasoning-start', id: 'n1' },
        { type: 'reasoning-delta', id: 'n1', delta: "I'll open the app." },
        { type: 'reasoning-end', id: 'n1' },
        {
          type: 'tool-input-start',
          toolCallId: 'tc1',
          toolName: 'execute',
          toolMetadata: { retrying: false },
        },
        { type: 'tool-input-available', toolCallId: 'tc1', toolName: 'execute', input: null },
        { type: 'data-progress', data: { text: 'Launching app...', tool: 'execute' } },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Done.' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: 'stop' },
      ),
    }))

    const result = await spawnCli(['-m', 'open the app'], { apiUrl: server.url, homeDir })
    expect(result.exitCode).toBe(0)
    // Final response on stdout
    expect(result.stdout).toContain('Done.')
    // Narration shown at default (level 1)
    expect(result.stderr).toContain("[sai] I'll open the app.")
    // Tool header and progress suppressed at level 1
    expect(result.stderr).not.toContain('[execute]')
    expect(result.stderr).not.toContain('Launching app')
  })

  it('--verbose=0: narrations and progress all suppressed', async () => {
    writeCreds()
    writeSession('machine-1')
    server.on('POST', '/v1/cli/message', () => ({
      sse: true,
      body: makeSseBody(
        { type: 'reasoning-start', id: 'n1' },
        { type: 'reasoning-delta', id: 'n1', delta: "I'll open the app." },
        { type: 'reasoning-end', id: 'n1' },
        {
          type: 'tool-input-start',
          toolCallId: 'tc1',
          toolName: 'execute',
          toolMetadata: { retrying: false },
        },
        { type: 'tool-input-available', toolCallId: 'tc1', toolName: 'execute', input: null },
        { type: 'data-progress', data: { text: 'Launching app...', tool: 'execute' } },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Done.' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: 'stop' },
      ),
    }))

    const result = await spawnCli(['--verbose=0', '-m', 'open the app'], {
      apiUrl: server.url,
      homeDir,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Done.')
    expect(result.stderr).not.toContain('Launching app')
    expect(result.stderr).not.toContain("I'll open the app.")
  })

  it('--verbose=1 (tier 1): narrations shown, tool_call and progress still suppressed', async () => {
    writeCreds()
    writeSession('machine-1')
    server.on('POST', '/v1/cli/message', () => ({
      sse: true,
      body: makeSseBody(
        { type: 'reasoning-start', id: 'n1' },
        { type: 'reasoning-delta', id: 'n1', delta: "I'll open the app." },
        { type: 'reasoning-end', id: 'n1' },
        {
          type: 'tool-input-start',
          toolCallId: 'tc1',
          toolName: 'execute',
          toolMetadata: { retrying: false },
        },
        { type: 'tool-input-available', toolCallId: 'tc1', toolName: 'execute', input: null },
        { type: 'data-progress', data: { text: 'Launching app...', tool: 'execute' } },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Done.' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: 'stop' },
      ),
    }))

    const result = await spawnCli(['--verbose=1', '-m', 'open the app'], {
      apiUrl: server.url,
      homeDir,
    })
    expect(result.exitCode).toBe(0)
    // Narration shows with [sai] tag
    expect(result.stderr).toContain("[sai] I'll open the app.")
    // Tool header and progress suppressed at tier 1
    expect(result.stderr).not.toContain('[execute]')
    expect(result.stderr).not.toContain('Launching app')
    // Final response still on stdout
    expect(result.stdout).toContain('Done.')
  })

  it('--verbose=2 (tier 2): narrations and progress lines shown, no bare tool header', async () => {
    writeCreds()
    writeSession('machine-1')
    server.on('POST', '/v1/cli/message', () => ({
      sse: true,
      body: makeSseBody(
        { type: 'reasoning-start', id: 'n1' },
        { type: 'reasoning-delta', id: 'n1', delta: "I'll check your emails." },
        { type: 'reasoning-end', id: 'n1' },
        {
          type: 'tool-input-start',
          toolCallId: 'tc1',
          toolName: 'execute',
          toolMetadata: { retrying: false },
        },
        { type: 'tool-input-available', toolCallId: 'tc1', toolName: 'execute', input: null },
        { type: 'data-progress', data: { text: 'Opening Gmail...', tool: 'execute' } },
        { type: 'data-progress', data: { text: 'Found 5 emails.', tool: 'execute' } },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Done.' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: 'stop' },
      ),
    }))

    const result = await spawnCli(['--verbose=2', '-m', 'check emails'], {
      apiUrl: server.url,
      homeDir,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("[sai] I'll check your emails.")
    // Progress lines tagged with tool name
    expect(result.stderr).toContain('[execute] Opening Gmail...')
    expect(result.stderr).toContain('[execute] Found 5 emails.')
    // No bare [execute] header (tool_call event produces no output)
    expect(result.stderr).not.toMatch(/\[execute\]\s*\n/)
    expect(result.stdout).not.toContain('Opening Gmail')
  })

  it('tool_error: always shown on stderr regardless of verbosity level', async () => {
    writeCreds()
    writeSession('machine-1')
    server.on('POST', '/v1/cli/message', () => ({
      sse: true,
      body: makeSseBody(
        {
          type: 'tool-input-start',
          toolCallId: 'tc1',
          toolName: 'execute',
          toolMetadata: { retrying: false },
        },
        { type: 'tool-input-available', toolCallId: 'tc1', toolName: 'execute', input: null },
        {
          type: 'tool-output-error',
          toolCallId: 'tc1',
          errorText: 'AppleScript execution failed: not permitted',
        },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: "I couldn't complete that step." },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: 'stop' },
      ),
    }))

    // Default — error always surfaces; no standalone header shown at any level
    const withoutFlag = await spawnCli(['-m', 'do a task'], { apiUrl: server.url, homeDir })
    expect(withoutFlag.exitCode).toBe(0)
    expect(withoutFlag.stderr).toContain('[execute] ✗ AppleScript execution failed: not permitted')
    expect(withoutFlag.stderr).not.toMatch(/\[execute\]\s*\n/) // no bare header

    // Same at --verbose=2 — tool error still shown, still no bare header
    const withVerbose = await spawnCli(['--verbose=2', '-m', 'do a task'], {
      apiUrl: server.url,
      homeDir,
    })
    expect(withVerbose.exitCode).toBe(0)
    expect(withVerbose.stderr).toContain('[execute] ✗ AppleScript execution failed: not permitted')
    expect(withVerbose.stderr).not.toMatch(/\[execute\]\s*\n/)
  })

  it('tool_call event never produces output at any verbosity level', async () => {
    writeCreds()
    writeSession('machine-1')
    server.on('POST', '/v1/cli/message', () => ({
      sse: true,
      body: makeSseBody(
        {
          type: 'tool-input-start',
          toolCallId: 'tc1',
          toolName: 'execute',
          toolMetadata: { retrying: false },
        },
        { type: 'tool-input-available', toolCallId: 'tc1', toolName: 'execute', input: null },
        {
          type: 'tool-input-start',
          toolCallId: 'tc2',
          toolName: 'execute',
          toolMetadata: { retrying: true },
        },
        { type: 'tool-input-available', toolCallId: 'tc2', toolName: 'execute', input: null },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Done.' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: 'stop' },
      ),
    }))

    const result = await spawnCli(['--verbose=3', '-m', 'do a task'], {
      apiUrl: server.url,
      homeDir,
    })
    expect(result.exitCode).toBe(0)
    // No bare [execute] header at any level
    expect(result.stderr).not.toMatch(/\[execute\]\s*\n/)
    expect(result.stderr).not.toContain('[execute] retrying...')
  })
})
