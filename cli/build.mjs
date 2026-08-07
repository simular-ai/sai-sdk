import { build } from 'esbuild'
import { chmodSync } from 'fs'

const outfile = 'dist/cli.cjs'

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile,
  // Bundle all deps (commander, etc.) so the output is a self-contained binary.
  external: [],
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
})

// esbuild writes the bundle 0644, which drops the executable bit the `bin`
// symlink (npm link / -g) relies on — so a rebuild would break `sai` with
// "permission denied". Restore +x on every build.
chmodSync(outfile, 0o755)
