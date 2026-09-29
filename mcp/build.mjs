import { build } from 'esbuild'
import { chmodSync } from 'fs'

const outfile = 'dist/server.js'

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
