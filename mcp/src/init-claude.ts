/**
 * `sai-mcp init-claude` — install the `sai` Claude Code skill that ships in this
 * package (SKILL.md at the package root) into `~/.claude/skills/sai/`, or
 * `./.claude/skills/sai/` with `--project`. Same shape as simulang's
 * `init-claude`: a manifest beside the skill records which package version
 * wrote it and a hash of what it wrote, so a later run can update our copy
 * without clobbering a file the user edited.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SKILL_NAME = 'sai'
const MANIFEST_FILE = '.sai-mcp-skill.json'

export interface InitClaudeOptions {
  project: boolean
  check: boolean
  force: boolean
}

export interface InitClaudeEnv {
  version: string
  /** Defaults: os.homedir(), process.cwd(), SKILL.md next to the package root. */
  homeDir?: string
  cwd?: string
  skillSource?: string
  out?: (line: string) => void
}

interface Manifest {
  version: string
  contentHash: string
  installedAt: string
}

export function parseInitClaudeFlags(
  argv: string[],
): { ok: true; options: InitClaudeOptions } | { ok: false; error: string } {
  const options: InitClaudeOptions = { project: false, check: false, force: false }
  for (const arg of argv) {
    if (arg === '--project') options.project = true
    else if (arg === '--user') options.project = false
    else if (arg === '--check') options.check = true
    else if (arg === '--force') options.force = true
    else return { ok: false, error: `Unknown flag: ${arg}` }
  }
  if (options.check && options.force) {
    return { ok: false, error: '--check and --force are mutually exclusive.' }
  }
  return { ok: true, options }
}

/** SKILL.md at the package root: `dist/server.js` and `src/init-claude.ts` are both one level down. */
function defaultSkillSource(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'SKILL.md')
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function readManifest(dir: string): Manifest | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8')) as Partial<Manifest>
    return typeof parsed.version === 'string' && typeof parsed.contentHash === 'string'
      ? (parsed as Manifest)
      : null
  } catch {
    return null
  }
}

export function runInitClaude(options: InitClaudeOptions, env: InitClaudeEnv): number {
  const out = env.out ?? ((line: string) => process.stdout.write(`${line}\n`))
  const base = options.project ? (env.cwd ?? process.cwd()) : (env.homeDir ?? homedir())
  const dir = join(base, '.claude', 'skills', SKILL_NAME)
  const target = join(dir, 'SKILL.md')
  const template = readFileSync(env.skillSource ?? defaultSkillSource(), 'utf8')
  const manifest = readManifest(dir)
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : undefined

  if (options.check) {
    if (existing === undefined) {
      out(`sai-mcp: no skill installed at ${dir}`)
      return 1
    }
    if (!manifest || hash(existing) !== hash(template)) {
      out(
        `sai-mcp: skill at ${dir} differs from ${env.version} — run \`sai-mcp init-claude\` to update.`,
      )
      return 1
    }
    out(`sai-mcp: skill at ${dir} is up to date (${manifest.version}).`)
    return 0
  }

  if (existing !== undefined && !options.force) {
    // Ours and untouched: safe to replace. Edited, or someone else's: leave it.
    const ours = manifest !== null && hash(existing) === manifest.contentHash
    if (!ours) {
      out(
        `sai-mcp: ${target} was changed or not written by sai-mcp; leaving it. Re-run with --force to overwrite.`,
      )
      return 1
    }
    if (manifest.contentHash === hash(template)) {
      out(`sai-mcp: skill at ${dir} is already up to date (${manifest.version}).`)
      return 0
    }
  }

  mkdirSync(dir, { recursive: true })
  writeFileSync(target, template)
  const next: Manifest = {
    version: env.version,
    contentHash: hash(template),
    installedAt: new Date().toISOString(),
  }
  writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(next, null, 2)}\n`)
  out(`sai-mcp: installed the ${SKILL_NAME} skill (${env.version}) at ${dir}`)
  out('Add the MCP server too, if you have not:')
  out('  claude mcp add sai -e SAI_API_KEY=sapi_... -- npx -y @simular-ai/sai-mcp')
  return 0
}
