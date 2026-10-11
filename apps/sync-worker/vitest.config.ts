import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const here = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@canvas/sync-protocol": fileURLToPath(new URL("../../packages/sync-protocol/src/index.ts", import.meta.url)),
      "@canvas/cloud-document": fileURLToPath(new URL("../../packages/cloud-document/src/index.ts", import.meta.url)),
      "pg": fileURLToPath(new URL("../sync/node_modules/pg/lib/index.js", import.meta.url)),
    },
  },
  test: {
    root: here,
    include: ["tests/**/*.test.ts"],
  },
})
