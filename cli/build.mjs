import { build } from 'esbuild'

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/cli.cjs',
  // Bundle all deps (commander, etc.) so the output is a self-contained binary.
  external: [],
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
})
