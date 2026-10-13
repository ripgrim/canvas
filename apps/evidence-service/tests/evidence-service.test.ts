import { describe, expect, it } from "vitest"
import { createEvidenceHandler, evidenceObject } from "../src/index"

const data = new TextEncoder().encode("evidence")
const bucket = {
  async head(key: string) { return key.endsWith(".png") ? object(data) : null },
  async get(key: string, options?: Readonly<{ range?: { offset: number; length: number } }>) {
    if (!key.endsWith(".png")) return null
    const range = options?.range
    return object(range ? data.slice(range.offset, range.offset + range.length) : data)
  },
}

function object(bytes: Uint8Array) {
  return { body: new Blob([Uint8Array.from(bytes).buffer]).stream(), size: bytes.byteLength, etag: "etag", httpEtag: '"etag"' }
}

describe("PR-EVIDENCE-008 public evidence media", () => {
  it("serves repository-scoped content-addressed media", async () => {
    const sha = "a".repeat(64)
    const handler = createEvidenceHandler({ EVIDENCE: bucket })
    const response = await handler(new Request(`https://evidence.test/42/${sha}.png`, { headers: { Range: "bytes=1-3" } }))
    expect(response.status).toBe(206)
    expect(response.headers.get("content-type")).toBe("image/png")
    expect(response.headers.get("content-range")).toBe("bytes 1-3/8")
    expect(await response.text()).toBe("vid")
  })

  it("rejects writes, other repositories, and arbitrary paths", async () => {
    const sha = "a".repeat(64)
    const handler = createEvidenceHandler({ EVIDENCE: bucket })
    expect(evidenceObject(`/42/${sha}.png`)?.key).toBe(`42/${sha}.png`)
    expect(evidenceObject(`/0/${sha}.png`)).toBeNull()
    expect((await handler(new Request(`https://evidence.test/42/${sha}.png`, { method: "PUT", body: "bad" }))).status).toBe(405)
    expect((await handler(new Request("https://evidence.test/42/../secret"))).status).toBe(404)
  })
})
