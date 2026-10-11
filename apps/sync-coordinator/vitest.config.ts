import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { alias: { "@canvas/sync-protocol": fileURLToPath(new URL("../../packages/sync-protocol/src/index.ts", import.meta.url)) } },
  test: { environment: "node" },
})
