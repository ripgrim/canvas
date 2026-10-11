import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const workspace = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@canvas/database/collaboration': `${workspace}/packages/database/src/collaboration.ts`,
      '@canvas/database/postgres': `${workspace}/packages/database/src/postgres.ts`,
      '@canvas/database': `${workspace}/packages/database/src/index.ts`,
      '@canvas/sync-protocol': `${workspace}/packages/sync-protocol/src/index.ts`,
    },
  },
  test: { include: ['tests/**/*.test.ts'] },
})
