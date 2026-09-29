import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseInitClaudeFlags, runInitClaude } from '../init-claude.js'

function setup(template = '# skill v1\n') {
  const root = mkdtempSync(join(tmpdir(), 'sai-mcp-init-'))
  const skillSource = join(root, 'SKILL.md')
  writeFileSync(skillSource, template)
  const home = join(root, 'home')
  const lines: string[] = []
  const env = {
    version: '0.1.0',
    homeDir: home,
    cwd: join(root, 'proj'),
    skillSource,
    out: (l: string) => lines.push(l),
  }
  const target = join(home, '.claude', 'skills', 'sai', 'SKILL.md')
  return { root, skillSource, env, lines, target }
}

const opts = (o: Partial<{ project: boolean; check: boolean; force: boolean }> = {}) => ({
  project: false,
  check: false,
  force: false,
  ...o,
})

describe('sai-mcp init-claude', () => {
  it('parses flags and rejects unknown or conflicting ones', () => {
    expect(parseInitClaudeFlags(['--project'])).toEqual({
      ok: true,
      options: opts({ project: true }),
    })
    expect(parseInitClaudeFlags(['--nope']).ok).toBe(false)
    expect(parseInitClaudeFlags(['--check', '--force']).ok).toBe(false)
  })

  it('installs into ~/.claude/skills/sai with a manifest, then reports up to date', () => {
    const { env, target } = setup()
    expect(runInitClaude(opts(), env)).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('# skill v1\n')
    expect(existsSync(join(target, '..', '.sai-mcp-skill.json'))).toBe(true)
    expect(runInitClaude(opts({ check: true }), env)).toBe(0)
    expect(runInitClaude(opts(), env)).toBe(0)
  })

  it('updates its own untouched copy when the packaged skill changes', () => {
    const { env, target, skillSource } = setup()
    runInitClaude(opts(), env)
    writeFileSync(skillSource, '# skill v2\n')
    expect(runInitClaude(opts({ check: true }), env)).toBe(1)
    expect(runInitClaude(opts(), env)).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('# skill v2\n')
  })

  it('leaves a user-edited skill alone unless --force', () => {
    const { env, target } = setup()
    runInitClaude(opts(), env)
    writeFileSync(target, '# my edits\n')
    expect(runInitClaude(opts(), env)).toBe(1)
    expect(readFileSync(target, 'utf8')).toBe('# my edits\n')
    expect(runInitClaude(opts({ force: true }), env)).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('# skill v1\n')
  })

  it('installs into the project with --project', () => {
    const { env } = setup()
    expect(runInitClaude(opts({ project: true }), env)).toBe(0)
    expect(existsSync(join(env.cwd, '.claude', 'skills', 'sai', 'SKILL.md'))).toBe(true)
  })
})
