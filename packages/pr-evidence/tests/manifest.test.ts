import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { parseEvidenceManifest } from "../src/manifest.js"
import { publishEvidence, renderEvidenceBlock, replaceEvidenceBlock, validateTrustedManifest } from "../src/publisher.js"
import { defineCapability, defineEvidenceScenario, planEvidence } from "../src/registry.js"

const sha = "a".repeat(64)
const gitSha = "b".repeat(40)
const manifest = {
  schemaVersion: 1,
  repository: { id: 1, fullName: "ripgrim/comp-canvas" },
  pullRequest: 12,
  baseSha: gitSha,
  headSha: gitSha,
  run: { id: 2, attempt: 1 },
  registryDigest: sha,
  files: [{ path: "packages/editor/src/a.ts", capabilities: ["editor.canvas.move"], evidence: "visual" }],
  scenarios: [{ id: "editor.transient-move", adapter: "browser", status: "passed", assertions: ["hud.follows"], assets: [{ path: `media/${sha}.png`, kind: "screenshot", role: "held", sha256: sha, bytes: 100, width: 200, height: 100 }] }],
} as const

describe("evidence manifests", () => {
  it("accepts a complete strict manifest", () => {
    expect(parseEvidenceManifest(manifest)).toEqual(manifest)
  })

  it("rejects unknown keys and unsafe paths", () => {
    expect(() => parseEvidenceManifest({ ...manifest, extra: true })).toThrow("keys")
    const asset = { ...manifest.scenarios[0].assets[0], path: "media/../secret.png" }
    expect(() => parseEvidenceManifest({ ...manifest, scenarios: [{ ...manifest.scenarios[0], assets: [asset] }] })).toThrow("Unsafe")
  })

  it("renders trusted titles and preserves unrelated prose", () => {
    const parsed = parseEvidenceManifest(manifest)
    const block = renderEvidenceBlock({ manifest: parsed, titles: { "editor.transient-move": "Transient move" }, assets: [{ sha256: sha, url: "https://github.com/user-attachments/assets/asset" }], manifestSha: sha })
    const body = replaceEvidenceBlock("Intro\n\n## Testing\nDone.\n", block)
    expect(body).toContain("Intro")
    expect(body).toContain("## Testing\nDone.")
    expect(body).toContain("Transient move")
    expect(replaceEvidenceBlock(body, block)).toBe(body)
  })

  it("rejects duplicate and incomplete markers", () => {
    expect(() => replaceEvidenceBlock("<!-- pr-evidence:start -->", "x")).toThrow("incomplete")
    expect(() => replaceEvidenceBlock("<!-- pr-evidence:start --><!-- pr-evidence:end --><!-- pr-evidence:start --><!-- pr-evidence:end -->", "x")).toThrow("duplicate")
  })

  it("PR-EVIDENCE-007 accepts only the trusted plan and run identity", () => {
    const capabilities = [defineCapability({ id: "editor.canvas.move", paths: ["packages/editor/src/a.ts"], evidence: "visual" })]
    const scenarios = [defineEvidenceScenario({ id: "editor.transient-move", title: "Transient move", capabilities: ["editor.canvas.move"], adapters: ["browser"], assertions: ["hud.follows"], screenshots: ["held"], video: false })]
    const plan = planEvidence({ changed: [{ path: "packages/editor/src/a.ts" }], adoptionSha: gitSha, capabilities, scenarios })
    const trusted = parseEvidenceManifest({ ...manifest, registryDigest: plan.registryDigest })
    const input = { manifest: trusted, repositoryId: 1, repository: "ripgrim/comp-canvas", pullRequest: 12, baseSha: gitSha, headSha: gitSha, runId: 2, runAttempt: 1, adoptionSha: gitSha, capabilities, scenarios }
    expect(() => validateTrustedManifest(input)).not.toThrow()
    expect(() => validateTrustedManifest({ ...input, headSha: "c".repeat(40) })).toThrow("identity")
  })

  it("rejects media outside the configured origin", () => {
    const parsed = parseEvidenceManifest(manifest)
    expect(() => renderEvidenceBlock({ manifest: parsed, titles: { "editor.transient-move": "Transient move" }, assets: [{ sha256: sha, url: "https://evil.test/a.png" }], manifestSha: sha, assetOrigins: ["https://evidence.canvas.test"] })).toThrow("asset URL")
  })

  it("PR-EVIDENCE-008 publishes once and verifies rendered output", async () => {
    const bytes = new Uint8Array(100)
    const assetSha = createHash("sha256").update(bytes).digest("hex")
    const parsed = parseEvidenceManifest({ ...manifest, scenarios: [{ ...manifest.scenarios[0], assets: [{ ...manifest.scenarios[0].assets[0], sha256: assetSha, path: `media/${assetSha}.png` }] }] })
    let body = "Intro"
    let writes = 0
    const pullRequests = {
      async read() { return { body, bodyHtml: body, baseSha: gitSha, headSha: gitSha } },
      async updateBody(_number: number, next: string) { writes += 1; body = next },
    }
    const result = await publishEvidence({
      manifest: parsed,
      manifestSha: sha,
      titles: { "editor.transient-move": "Transient move" },
      assetOrigins: ["https://evidence.canvas.test"],
      pullRequests,
      media: { async put(asset) { return { sha256: asset.sha256, url: `https://evidence.canvas.test/${asset.sha256}.png` } } },
      async readAsset() { return bytes },
    })
    expect(result.changed).toBe(true)
    const repeated = await publishEvidence({
      manifest: parsed,
      manifestSha: sha,
      titles: { "editor.transient-move": "Transient move" },
      assetOrigins: ["https://evidence.canvas.test"],
      pullRequests,
      media: { async put(asset) { return { sha256: asset.sha256, url: `https://evidence.canvas.test/${asset.sha256}.png` } } },
      async readAsset() { return bytes },
    })
    expect(repeated.changed).toBe(false)
    expect(writes).toBe(1)
  })
})
