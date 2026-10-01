import { build } from 'esbuild'
import { chmodSync, readFileSync } from 'fs'

const outfile = 'dist/server.js'
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))

// The MCP Apps task view (src/app-view.ts): one self-contained page, the
// browser script inlined, baked into the server bundle as a string.
const ui = await build({
  entryPoints: ['src/ui/task-view.ts'],
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  minify: true,
  write: false,
  define: { __SAI_VERSION__: JSON.stringify(version) },
})
const script = ui.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')
const taskViewHtml = readFileSync('src/ui/task-view.html', 'utf8').replace(
  '/*__SAI_TASK_VIEW_JS__*/',
  () => script,
)

await build({
  entryPoints: ['src/server.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  // ESM to match `"type": "module"` (the bin is `dist/server.js`, not `.cjs`).
  format: 'esm',
  outfile,
  // Bundle every dep (MCP SDK, zod) so `npx -y @simular-ai/sai-mcp` runs a
  // single self-contained file.
  external: [],
  sourcemap: true,
  define: { __SAI_TASK_VIEW_HTML__: JSON.stringify(taskViewHtml) },
  banner: {
    // The MCP SDK's CJS-only transitive deps call `require` at runtime; an ESM
    // bundle has none, so provide one. The shebang must stay on line 1.
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __createRequire } from 'module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
})

// esbuild writes the bundle 0644, which drops the executable bit the `bin`
// symlink relies on. Restore +x on every build.
chmodSync(outfile, 0o755)
