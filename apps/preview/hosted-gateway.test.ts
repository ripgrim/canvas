import { describe, expect, it, vi } from "vitest"

import { issueHostedPreviewCapability } from "@canvas/preview-runtime/hosted-capability"
import { createHostedPreviewGateway } from "./hosted-gateway.js"

const artifactId = "00000000-0000-4000-8000-000000000501"
const previewOrigin = "https://preview.canvas.test"
const assetsOrigin = "https://assets.canvas.test"
const editorOrigin = "https://canvas.test"
const desktopOrigin = "design-editor://app"
const serviceToken = "hosted-preview-service-token-at-least-32-bytes"
const capabilitySecret = "hosted-preview-capability-secret-at-least-32-bytes"
const digest = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"

async function token(now = 1_800_000_000): Promise<string> {
  return issueHostedPreviewCapability({
    artifactId,
    audience: previewOrigin,
    secret: capabilitySecret,
    now,
    lifetimeSeconds: 120,
    nonce: "00000000-0000-4000-8000-000000000601",
  })
}

function upstream(body = "hello", headers: HeadersInit = {}): Response {
  return new Response(body, {
    headers: {
      "Content-Length": String(new TextEncoder().encode(body).byteLength),
      "Content-Type": "text/html; charset=utf-8",
      ETag: `"${digest}"`,
      "X-Canvas-Artifact-Id": artifactId,
      "X-Canvas-Artifact-Sha256": digest,
      ...headers,
    },
  })
}

describe("hosted preview gateway", () => {
  it("COMP-V2-CODE-006 serves one capability-bound artifact under the isolated execution policy", async () => {
    const requestFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${assetsOrigin}/internal/hosted-previews/${artifactId}/files/index.html`)
      expect(init?.method).toBe("GET")
      expect(new Headers(init?.headers).get("x-canvas-service-token")).toBe(serviceToken)
      expect(new Headers(init?.headers).has("origin")).toBe(false)
      expect(init?.redirect).toBe("manual")
      return upstream()
    })
    const gateway = createHostedPreviewGateway({
      previewOrigin,
      assetsOrigin,
      editorOrigins: [editorOrigin, desktopOrigin],
      serviceToken,
      capabilitySecret,
      fetch: requestFetch,
      now: () => 1_800_000_001,
      requestId: () => "request-1",
    })
    const response = await gateway(new Request(`${previewOrigin}/hosted/${artifactId}/${await token()}/index.html`))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("hello")
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'")
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'none'")
    expect(response.headers.get("content-security-policy")).toContain(`frame-ancestors ${editorOrigin}`)
    expect(response.headers.get("content-security-policy")).toContain(desktopOrigin)
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    expect(response.headers.get("x-canvas-request-id")).toBe("request-1")
    expect(requestFetch).toHaveBeenCalledOnce()
  })

  it("COMP-V2-CODE-006 rejects the public function route and query admission", async () => {
    const requestFetch = vi.fn(async () => upstream())
    const gateway = createHostedPreviewGateway({
      previewOrigin,
      assetsOrigin,
      editorOrigins: [editorOrigin, desktopOrigin],
      serviceToken,
      capabilitySecret,
      fetch: requestFetch,
      now: () => 1_800_000_001,
      requestId: () => "request-direct-api",
    })
    const grant = await token()
    expect((await gateway(new Request(`${previewOrigin}/api/hosted/${artifactId}/${grant}/index.html`))).status).toBe(404)
    expect((await gateway(new Request(`${previewOrigin}/hosted/${artifactId}/${grant}/index.html?__canvas_path=ignored`))).status).toBe(404)
    expect(requestFetch).not.toHaveBeenCalled()
  })

  it("COMP-V2-CODE-006 rejects expired, cross-artifact, query, and mutating requests before asset access", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const requestFetch = vi.fn(async () => upstream())
    const gateway = createHostedPreviewGateway({
      previewOrigin,
      assetsOrigin,
      editorOrigins: [editorOrigin],
      serviceToken,
      capabilitySecret,
      fetch: requestFetch,
      now: () => 1_800_000_120,
      requestId: () => "request-2",
    })
    const grant = await token()
    expect((await gateway(new Request(`${previewOrigin}/hosted/${artifactId}/${grant}/index.html`))).status).toBe(404)
    expect((await gateway(new Request(`${previewOrigin}/hosted/00000000-0000-4000-8000-000000000502/${grant}/index.html`))).status).toBe(404)
    expect((await gateway(new Request(`${previewOrigin}/hosted/${artifactId}/${grant}/index.html?download=1`))).status).toBe(404)
    expect((await gateway(new Request(`${previewOrigin}/hosted/${artifactId}/${grant}/index.html`, { method: "POST" }))).status).toBe(405)
    expect(requestFetch).not.toHaveBeenCalled()
    expect(logged.mock.calls.flat().join(" ")).not.toContain(grant)
    expect(logged.mock.calls.flat().join(" ")).toContain("[capability]")
    logged.mockRestore()
  })

  it("COMP-V2-CODE-006 refuses redirects and malformed trusted-service responses", async () => {
    const grant = await token()
    const responses = [
      new Response(null, { status: 302, headers: { Location: "https://evil.example" } }),
      upstream("hello", { "X-Canvas-Artifact-Sha256": "0".repeat(64) }),
    ]
    const requestFetch = vi.fn(async () => responses.shift()!)
    const gateway = createHostedPreviewGateway({
      previewOrigin,
      assetsOrigin,
      editorOrigins: [editorOrigin],
      serviceToken,
      capabilitySecret,
      fetch: requestFetch,
      now: () => 1_800_000_001,
      requestId: () => "request-3",
    })
    expect((await gateway(new Request(`${previewOrigin}/hosted/${artifactId}/${grant}/index.html`))).status).toBe(502)
    expect((await gateway(new Request(`${previewOrigin}/hosted/${artifactId}/${grant}/index.html`))).status).toBe(502)
  })
})
