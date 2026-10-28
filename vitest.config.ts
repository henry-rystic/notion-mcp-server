import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The notion-twin suite needs a running twin: `npm run test:twin`.
    exclude: ['**/node_modules/**', '**/build/**', 'src/__tests__/notion-twin.integration.test.ts'],
  },
})
