#!/usr/bin/env node
/**
 * The docs' code blocks, as test data for every SDK's snippet tests.
 *
 *   node conformance/snippets.mjs --lang python          # the committed snapshot, as JSON
 *   node conformance/snippets.mjs --lang python --docs <dir>   # read live docs instead
 *   node conformance/snippets.mjs sync [--docs <dir>] [--ref <branch>]
 *
 * The docs live in simular-ai/sai-platform. `sync` takes the code blocks of every SDK language
 * from its pages (`src/docs/content`) and writes them to `snippets/<lang>.json`, which is
 * committed: the tests and CI read only this repo. Without `--docs` (or `SAI_DOCS_DIR`), `sync`
 * clones sai-platform at `--ref` (default `main`) with your own git credentials.
 *
 * Each entry is `{ file, line, title, context, code }`. A block that imports nothing
 * continues an earlier block on its page, which `context` holds: the last block before it that
 * imports, and on an SDK page (`sdks/*.md`), for every block after the first, the page's first
 * block. `context` is empty for a block that stands alone. A runner puts the context first and the
 * block after it, in a scope of its own where the language has one, so the block may reuse the
 * context's names; the block's imports go to the top of the program. A block after
 * `<!-- snippet: skip -->` on its own line is left out, and is not context for the next.
 */

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ALIASES = {
  python: ['python', 'py'],
  typescript: ['typescript', 'ts'],
  go: ['go'],
  java: ['java'],
  csharp: ['csharp', 'cs', 'c#'],
  ruby: ['ruby', 'rb'],
}
// A block that starts a program: it imports the SDK or something else.
const STARTS = {
  python: /^(from|import) /m,
  typescript: /^import /m,
  go: /^import /m,
  java: /^import /m,
  csharp: /^using /m,
  ruby: /^require /m,
}

const HERE = dirname(fileURLToPath(import.meta.url))
const SNAPSHOTS = join(HERE, 'snippets')
const REPO = 'https://github.com/simular-ai/sai-platform.git'
// The SDK directory of each language: `sync` writes snapshots for the SDKs in this checkout.
const SDK_DIRS = {
  python: 'python',
  typescript: 'typescript',
  go: 'go',
  java: 'java',
  csharp: 'dotnet',
  ruby: 'ruby',
}

/** The committed snippets of one language. */
export function snapshot(lang) {
  const p = join(SNAPSHOTS, `${lang}.json`)
  if (!existsSync(p)) throw new Error(`no snapshot ${p}: run node conformance/snippets.mjs sync`)
  return JSON.parse(readFileSync(p, 'utf8')).snippets
}

/** Write every language's snapshot from the docs at `dir`, or from a fresh clone at `ref`. */
export function sync({ dir, ref = 'main' } = {}) {
  let clone
  let source = { docs: dir }
  if (!dir) {
    clone = mkdtempSync(join(tmpdir(), 'sai-platform-'))
    const git = (...args) =>
      execFileSync('git', args, { cwd: clone, stdio: ['ignore', 'pipe', 'inherit'] })
    git(
      'clone',
      '--quiet',
      '--depth',
      '1',
      '--branch',
      ref,
      '--filter=blob:none',
      '--sparse',
      REPO,
      '.',
    )
    git('sparse-checkout', 'set', 'src/docs/content')
    source = {
      repo: 'simular-ai/sai-platform',
      ref,
      commit: git('rev-parse', 'HEAD').toString().trim(),
    }
    dir = join(clone, 'src/docs/content')
  }
  try {
    const langs = Object.keys(ALIASES).filter((l) => existsSync(join(HERE, '..', SDK_DIRS[l])))
    for (const lang of langs) {
      const snippets = extract(lang, dir)
      writeFileSync(
        join(SNAPSHOTS, `${lang}.json`),
        JSON.stringify({ source, snippets }, null, 2) + '\n',
      )
      process.stderr.write(`${lang}: ${snippets.length} snippets\n`)
    }
  } finally {
    if (clone) rmSync(clone, { recursive: true, force: true })
  }
}

function* markdownFiles(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* markdownFiles(p)
    else if (name.endsWith('.md')) yield p
  }
}

export function extract(lang, dir) {
  const tags = ALIASES[lang]
  if (!tags) throw new Error(`unknown language ${lang}; one of ${Object.keys(ALIASES).join(', ')}`)
  if (!existsSync(dir))
    throw new Error(
      `no docs at ${dir}: check out sai-platform next to sai-sdk, or set SAI_DOCS_DIR`,
    )
  const out = []
  for (const file of markdownFiles(dir)) {
    const rel = relative(dir, file)
    const lines = readFileSync(file, 'utf8').split('\n')
    const sdkPage = rel.startsWith(`sdks${sep}`)
    let skip = false
    let context = ''
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim() === '<!-- snippet: skip -->') {
        skip = true
        continue
      }
      const open = /^( *)(`{3,})([^\s`]*)(.*)$/.exec(line)
      if (!open) {
        if (line.trim() !== '') skip = false
        continue
      }
      const [, indent, ticks, language, meta] = open
      const close = new RegExp(`^ {0,${indent.length + 3}}${ticks}\`*\\s*$`)
      let end = i + 1
      while (end < lines.length && !close.test(lines[end])) end++
      const code = lines
        .slice(i + 1, end)
        .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart()))
        .join('\n')
      if (tags.includes(language) && !skip) {
        const starts = STARTS[lang].test(code)
        out.push({
          file: rel,
          line: i + 1,
          title: /title="([^"]*)"/.exec(meta)?.[1] ?? null,
          context: starts && !sdkPage ? '' : context,
          code,
        })
        if (starts && !(sdkPage && context)) context = code
      }
      skip = false
      i = end
    }
  }
  return out
}

// realpath: the script may be reached through a symlink.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  if (process.argv[2] === 'sync') {
    const dir = arg('docs') ?? process.env.SAI_DOCS_DIR
    sync({ dir: dir && resolve(dir), ref: arg('ref') })
  } else {
    const lang = arg('lang')
    if (!lang) {
      process.stderr.write(
        'usage: node conformance/snippets.mjs --lang <language> [--docs <dir>] | sync\n',
      )
      process.exit(2)
    }
    const docs = arg('docs') ?? process.env.SAI_DOCS_DIR
    const snippets = docs ? extract(lang, resolve(docs)) : snapshot(lang)
    process.stdout.write(JSON.stringify(snippets, null, 2) + '\n')
  }
}
