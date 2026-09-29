import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'sai-mcp',
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    testTimeout: 5_000,
  },
})
