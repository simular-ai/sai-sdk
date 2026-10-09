import { defineConfig } from 'vitest/config'

// own config so vitest does not climb to the monorepo root's project list
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
