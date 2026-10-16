import { afterEach, describe, expect, it, vi } from "vitest"

import endpoint from "./[...path].js"

describe("hosted preview Vercel adapter", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("COMP-V2-CODE-006 rejects direct API and query-string capability routes", async () => {
    vi.stubEnv("HOSTED_PREVIEW_ORIGIN", "https://preview.canvas.test")
    vi.stubEnv("ASSETS_ORIGIN", "https://assets.canvas.test")
    vi.stubEnv("HOSTED_PREVIEW_EDITOR_ORIGINS", "https://canvas.test,design-editor://app")
    vi.stubEnv("API_SERVICE_TOKEN", "hosted-preview-service-token-at-least-32-bytes")
    vi.stubEnv("HOSTED_PREVIEW_CAPABILITY_SECRET", "hosted-preview-capability-secret-at-least-32-bytes")

    const direct = await endpoint.fetch(new Request("https://preview.canvas.test/api/hosted/artifact/capability/index.html"))
    const query = await endpoint.fetch(new Request("https://preview.canvas.test/hosted/artifact/index.html?__canvas_path=capability"))
    expect(direct.status).toBe(404)
    expect(query.status).toBe(404)
  })
})
