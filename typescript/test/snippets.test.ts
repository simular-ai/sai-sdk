/**
 * Every TypeScript block in the docs (sai-platform, snapshotted in conformance/snippets) runs
 * against the mock server's fake API. See ../../conformance/README.md#docs-snippets. Runs the
 * built package: `npm run build` first.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// @ts-expect-error plain JavaScript, shared by every SDK's tests
import { extract, snapshot } from '../../conformance/snippets.mjs'

interface Snippet {
  file: string
  line: number
  context: string
  code: string
}

const CONFORMANCE = fileURLToPath(new URL('../../conformance/', import.meta.url))
// Inside the package, so `@simular-ai/sai-sdk` resolves to this build.
const WORK = fileURLToPath(new URL('../.snippets/', import.meta.url))
// SAI_DOCS_DIR: the live docs instead of the snapshot, while editing them.
const DOCS = process.env.SAI_DOCS_DIR
const snippets = (DOCS ? extract('typescript', DOCS) : snapshot('typescript')) as Snippet[]

const isImport = (l: string): boolean => l.startsWith('import ')

/** The block as a module: imports first, then the context, then the block in a scope of its own. */
function program(s: Snippet): string {
  if (!s.context) return s.code
  const imports = [...new Set(`${s.context}\n${s.code}`.split('\n').filter(isImport))]
  const body = (code: string): string =>
    code
      .split('\n')
      .filter((l) => !isImport(l))
      .join('\n')
  return `${imports.join('\n')}\n${body(s.context)}\n{\n${body(s.code)}\n}\n`
}

let server: ChildProcess
let mockUrl: string

beforeAll(async () => {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  cpSync(`${CONFORMANCE}fixtures`, WORK, { recursive: true })
  server = spawn('node', [`${CONFORMANCE}server.mjs`], { stdio: ['pipe', 'pipe', 'inherit'] })
  const line = await new Promise<string>((resolve) => {
    createInterface({ input: server.stdout! }).once('line', resolve)
  })
  mockUrl = line.replace('SAI_MOCK_URL=', '')
})

afterAll(() => {
  server?.kill()
})

describe('docs snippets', () => {
  for (const s of snippets) {
    it(`${s.file}:${s.line}`, { timeout: 60_000 }, async () => {
      await fetch(`${mockUrl}/__mock/reset`, { method: 'POST' })
      const path = `${WORK}${s.file.replace(/\W/g, '_')}_${s.line}.mts`
      writeFileSync(path, program(s))
      const run = promisify(execFile)(
        'node',
        ['--no-warnings', '--experimental-strip-types', path],
        {
          cwd: WORK,
          timeout: 50_000,
          env: {
            ...process.env,
            SAI_API_KEY: 'sapi_docs',
            SAI_ORG_KEY: 'sapi_docs_org',
            SAI_API_URL: mockUrl,
            SAI_ORG_ID: 'org_docs',
          },
        },
      )
      await expect(
        run.catch((e: { stderr?: string }) => Promise.reject(new Error(e.stderr))),
      ).resolves.toBeDefined()
    })
  }
})
