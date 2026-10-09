/**
 * Control sessions: drive a cloud computer directly with Simulang. No agent.
 *
 * Maps to `/v1/sessions` today. Research preview: the account needs direct
 * control enabled.
 */

import { BlockError, GoneError } from './errors.js'
import type { Http } from './http.js'
import { idOf, type MachineRef } from './machines.js'
import { parseExecResult, type ExecResult } from './types.js'

const PATH = '/v1/sessions'

export class ControlSessions {
  constructor(private readonly http: Http) {}

  /**
   * Take a cloud computer. Resolves once the session holds it, up to ~3
   * minutes when a Sai task holds it or it has to start. Close it when done
   * (`await using`, or `try/finally`): Sai's tasks on that computer wait until then.
   */
  async open(opts: { machine?: MachineRef } = {}): Promise<ControlSession> {
    const d = await this.http.json<Record<string, unknown>>('POST', PATH, {
      json: opts.machine ? { machineId: idOf(opts.machine) } : {},
      timeoutMs: 240_000,
    })
    return new ControlSession(
      this.http,
      String(d.sessionId),
      typeof d.machineId === 'string' ? d.machineId : '',
      Number(d.expiresAfterIdleSec ?? 0),
    )
  }
}

export class ControlSession {
  private closed = false

  constructor(
    private readonly http: Http,
    readonly id: string,
    readonly machineId: string,
    readonly idleTimeoutSec: number,
  ) {}

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  /**
   * Run one Simulang (JavaScript) block. Use `var` for anything the next block
   * needs. A block that throws, times out or is interrupted still resolves:
   * check `result.error`. Throws `GoneError` when the session lost the computer.
   */
  async exec(code: string, opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
    const body: Record<string, unknown> = { code }
    if (opts.timeoutMs !== undefined) body.timeoutMs = opts.timeoutMs
    const d = await this.http.json<Record<string, unknown>>('POST', `${PATH}/${this.id}/exec`, {
      json: body,
      timeoutMs: (opts.timeoutMs ?? 120_000) + 45_000,
    })
    return parseExecResult(d)
  }

  /** Run a shell command: `{ stdout, stderr, exitCode, timedOut }`. */
  async shell(
    command: string,
    opts: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    const args: Record<string, unknown> = { command }
    if (opts.cwd) args.cwd = opts.cwd
    const r = await this.exec(`await machine.exec(${JSON.stringify(args)})`, {
      timeoutMs: opts.timeoutMs,
    })
    raiseOnBlockError(r)
    return r.result as { stdout: string; stderr: string; exitCode: number; timedOut: boolean }
  }

  async readFile(path: string): Promise<string> {
    const r = await this.exec(`await machine.readFile(${JSON.stringify({ path })})`)
    raiseOnBlockError(r)
    return r.result as string
  }

  async writeFile(path: string, text: string): Promise<void> {
    const r = await this.exec(
      `await machine.writeToFile(${JSON.stringify({ path, text, overwrite: true })})`,
    )
    raiseOnBlockError(r)
  }

  /**
   * The whole screen as PNG bytes. Needs the computer's screen-capture service;
   * throws `BlockError` where it is off (a page or app snapshot still carries an image).
   */
  async screenshot(): Promise<Uint8Array> {
    const r = await this.exec('var __sai_page = await machine.pageContent(); null')
    raiseOnBlockError(r)
    if (!r.screenshotPng) {
      throw new BlockError(
        'exception',
        r.screenshotOmitted ? 'screenshot too large to return' : 'no screenshot',
      )
    }
    return r.screenshotPng
  }

  /** Stop the running block at its next step. False if nothing was running. */
  async interrupt(): Promise<boolean> {
    const d = await this.http.json<{ interrupted?: boolean } | null>(
      'POST',
      `${PATH}/${this.id}/interrupt`,
    )
    return Boolean(d?.interrupted)
  }

  /** `{ status: open|closed, closedReason?, lastExecAt, ... }`. */
  get(): Promise<Record<string, unknown>> {
    return this.http.json('GET', `${PATH}/${this.id}`)
  }

  /** Clear the REPL and release the computer. Safe to call twice. */
  async close(): Promise<void> {
    if (this.closed) return
    try {
      await this.http.request('DELETE', `${PATH}/${this.id}`)
    } catch (err) {
      if (!(err instanceof GoneError)) throw err
    }
    this.closed = true
  }
}

function raiseOnBlockError(r: ExecResult): void {
  if (r.error) throw new BlockError(r.error.kind, r.error.message)
}
