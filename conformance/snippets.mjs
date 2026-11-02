#!/usr/bin/env node
/**
 * The code blocks of one language in the docs, as JSON on stdout.
 *
 *   node conformance/snippets.mjs --lang python [--docs <dir>]
 *
 * `--docs` defaults to `SAI_DOCS_DIR`, then `../sai-platform/src/docs/content` next to this
 * checkout. Each entry is `{ file, line, title, context, code }`. A block that imports nothing
 * continues an earlier block on its page, which `context` holds: the last block before it that
 * imports, and on an SDK page (`sdks/*.md`), for every block after the first, the page's first
 * block. `context` is empty for a block that stands alone. A runner puts the context first and the
 * block after it, in a scope of its own where the language has one, so the block may reuse the
 * context's names; the block's imports go to the top of the program. A block after `<!-- snippet: skip -->`
 * on its own line is left out, and is not context for the next.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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

export function docsDir(arg) {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(
    arg ?? process.env.SAI_DOCS_DIR ?? join(here, '../../sai-platform/src/docs/content'),
  )
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  const lang = arg('lang')
  if (!lang) {
    process.stderr.write('usage: node conformance/snippets.mjs --lang <language> [--docs <dir>]\n')
    process.exit(2)
  }
  process.stdout.write(JSON.stringify(extract(lang, docsDir(arg('docs'))), null, 2) + '\n')
}
