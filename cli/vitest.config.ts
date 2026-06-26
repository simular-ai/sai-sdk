import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'sapi-cli',
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    testTimeout: 5_000,
  },
})
