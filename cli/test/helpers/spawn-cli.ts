import { spawn } from 'child_process'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_PATH = resolve(__dirname, '../../src/cli.ts')

export interface SpawnResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface SpawnOptions {
  /** Mock server base URL, set as SAPI_API_URL in the subprocess env */
  apiUrl: string
  /** Pre-created temp HOME directory */
  homeDir: string
  /** Lines to write to stdin (one per readline prompt) */
  stdinLines?: string[]
  /** Per-process timeout in ms; defaults to 15 000 */
  timeout?: number
}

/**
 * Spawns `tsx src/cli.ts [args]` as a subprocess with HOME set to homeDir and
 * SAPI_API_URL set to apiUrl. Captures stdout/stderr and waits for exit.
 */
export function spawnCli(args: string[], opts: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve: (r: SpawnResult) => void, reject) => {
    // Run the TS CLI via `node --import tsx` instead of the node_modules/.bin/tsx
    // shim: the extensionless shim is not directly spawnable on Windows.
    const proc = spawn(process.execPath, ['--import', 'tsx', CLI_PATH, ...args], {
      env: {
        ...process.env,
        // os.homedir() reads HOME on POSIX and USERPROFILE on Windows — set both
        // so the child's ~/.sapi resolves to the test's temp dir on every platform.
        HOME: opts.homeDir,
        USERPROFILE: opts.homeDir,
        SAPI_API_URL: opts.apiUrl,
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

    // Write stdin data immediately (buffered by the pipe until readline reads it)
    if (opts.stdinLines && opts.stdinLines.length > 0) {
      for (const line of opts.stdinLines) {
        proc.stdin.write(`${line}\n`)
      }
    }
    // Always close stdin so readline doesn't wait for more input
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
