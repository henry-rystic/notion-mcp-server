import { defineConfig } from 'vitest/config'

// `npm run test:twin`: the end-to-end suite against notion-twin, kept out of
// `npm test` (see vitest.config.ts) because it needs a running twin.
export default defineConfig({
  test: {
    include: ['src/__tests__/notion-twin.integration.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
})
