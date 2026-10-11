import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import worker, { handleRequest } from "../src/index.js"
import { validateWorkerEnv } from "../src/config.js"
import type { SyncWorkerEnv } from "../src/config.js"

const fileId = "c4964764-a27f-4345-8b6a-eada5b77f339"
const generationId = "3d6c7f8e-20bc-47eb-b264-d190a9239e70"
const origin = "https://canvas.example"
const secret = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString("base64url")

function handshake(overrides: Record<string, string> = {}, path = `/sync/${fileId}?tabId=tab-1`, method = "GET"): Request {
  return new Request(`https://sync.example${path}`, { method, headers: { Origin: origin, Upgrade: "websocket", Connection: "keep-alive, Upgrade", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Protocol": "canvas-sync-v2", Cookie: "session=private", Authorization: "Bearer browser", ...overrides } })
}

function environment() {
  const requests: Request[] = []
  const env: SyncWorkerEnv = { API_ORIGIN: "https://api.example", COLLABORATION_ADMISSION_SERVICE_TOKEN: "a".repeat(32), COLLABORATION_BUILD_ID: "0.1.0", SYNC_COORDINATOR_INTERNAL_SECRET: secret, ALLOWED_ORIGINS: origin, SYNC_COORDINATOR: { async fetch(request) { requests.push(request); return new Response("coordinator", { status: 200 }) } } }
  return { env, requests }
}

function mockAdmission(status = 200, body: unknown = { claims: { subjectId: "user:1", displayName: "Alpha", avatarUrl: "https://images.example/alpha.png", fileId, role: "owner", generationId, protocolEpoch: 2, accessEpoch: "1" }, generation: { status: "active" }, compatibility: { status: "compatible", protocolEpoch: 2, buildId: "0.1.0" } }) {
  const requests: Request[] = []
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => { requests.push(new Request(input, init)); return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }) }))
  return requests
}

afterEach(() => vi.unstubAllGlobals())

describe("public RFC6455 admission", () => {
  it("admits a real handshake through the private coordinator binding", async () => {
    const api = mockAdmission(); const state = environment()
    expect((await handleRequest(handshake(), state.env)).status).toBe(200)
    expect(api).toHaveLength(1); expect(state.requests).toHaveLength(1)
    expect(await api[0]!.json()).toEqual({ fileId, clientId: 'tab-1', protocolEpoch: 2, buildId: '0.1.0' })
    const forwarded = state.requests[0]!
    expect(forwarded.headers.get("Cookie")).toBeNull()
    expect(forwarded.headers.get("Authorization")).toBeNull()
    expect(forwarded.headers.get("X-Canvas-Collaboration-Token")).toBeNull()
    expect(forwarded.headers.get("Sec-WebSocket-Key")).toBe("dGhlIHNhbXBsZSBub25jZQ==")
    const internalAdmission = forwarded.headers.get("X-Canvas-Sync-Admission")!
    const envelope = JSON.parse(Buffer.from(internalAdmission.split(".")[0]!, "base64url").toString("utf8"))
    expect(envelope.admissionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(envelope.claims.buildId).toBe("0.1.0")
  })

  it.each([
    ["method", handshake({}, undefined, "POST")],
    ["Upgrade", handshake({ Upgrade: "" })],
    ["Connection", handshake({ Connection: "keep-alive" })],
    ["version", handshake({ "Sec-WebSocket-Version": "12" })],
    ["missing key", handshake({ "Sec-WebSocket-Key": "" })],
    ["malformed key", handshake({ "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25j" })],
    ["unknown protocol", handshake({ "Sec-WebSocket-Protocol": "evil" })],
    ["multiple protocols", handshake({ "Sec-WebSocket-Protocol": "canvas-sync-v2, evil" })],
    ["empty protocol", handshake({ "Sec-WebSocket-Protocol": "" })],
  ])("rejects an invalid %s before admission", async (_name, request) => {
    const api = mockAdmission(); const state = environment()
    expect((await handleRequest(request, state.env)).status).toBe(426)
    expect(api).toHaveLength(0); expect(state.requests).toHaveLength(0)
  })

  it("rejects untrusted origins and client-selected generations", async () => {
    const api = mockAdmission(); const state = environment()
    expect((await handleRequest(handshake({ Origin: "https://evil.example" }), state.env)).status).toBe(403)
    expect((await handleRequest(handshake({}, `/sync/${fileId}?tabId=tab-1&generationId=${generationId}`), state.env)).status).toBe(404)
    expect(api).toHaveLength(0)
  })

  it("rejects missing Origin and malformed route identities", async () => {
    const api = mockAdmission(); const state = environment()
    expect((await handleRequest(handshake({ Origin: "" }), state.env)).status).toBe(403)
    expect((await handleRequest(handshake({}, "/sync/not-a-file?tabId=tab-1"), state.env)).status).toBe(404)
    expect((await handleRequest(handshake({}, `/sync/${fileId}?tabId=bad%20tab`), state.env)).status).toBe(404)
    expect(api).toHaveLength(0)
  })

  it("does not route an authentication failure", async () => {
    mockAdmission(401, { error: { code: "unauthorized" } }); const state = environment()
    expect((await handleRequest(handshake(), state.env)).status).toBe(401)
    expect(state.requests).toHaveLength(0)
  })

  it("fails closed on a malformed successful admission response", async () => {
    mockAdmission(200, { claims: { fileId }, generation: { status: "active" } }); const state = environment()
    expect((await handleRequest(handshake(), state.env)).status).toBe(503)
    expect(state.requests).toHaveLength(0)
  })

  it.each([
    ["unnormalized display name", { displayName: " Alpha " }],
    ["overlong display name", { displayName: "A".repeat(81) }],
    ["bidi override display name", { displayName: "Al\u202Epha" }],
    ["bidi isolate display name", { displayName: "Al\u2067pha" }],
    ["zero-width display name", { displayName: "Al\u200Bpha" }],
    ["cleartext avatar", { avatarUrl: "http://images.example/alpha.png" }],
    ["overlong avatar", { avatarUrl: `https://images.example/${"a".repeat(2_048)}` }],
    ["extra identity key", { email: "alpha@example.test" }],
  ])("fails closed on %s in an otherwise signed admission response", async (_name, identity) => {
    const claims = { subjectId: "user:1", displayName: "Alpha", avatarUrl: null, fileId, role: "owner", generationId, protocolEpoch: 2, accessEpoch: "1", ...identity }
    mockAdmission(200, { claims, generation: { status: "active" }, compatibility: { status: "compatible", protocolEpoch: 2, buildId: "0.1.0" } })
    const state = environment()
    expect((await handleRequest(handshake(), state.env)).status).toBe(503)
    expect(state.requests).toHaveLength(0)
  })

  it("fails closed when admission is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline") }))
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const state = environment()
    expect((await worker.fetch(handshake(), state.env)).status).toBe(503)
    expect(state.requests).toHaveLength(0)
  })
})

describe("configuration", () => {
  it("allows plaintext API transport only on loopback", () => {
    const state = environment()
    expect(() => validateWorkerEnv({ ...state.env, API_ORIGIN: "http://api.example" })).toThrow(/HTTPS/)
    expect(validateWorkerEnv({ ...state.env, API_ORIGIN: "http://127.0.0.1:4320" }).apiOrigin).toBe("http://127.0.0.1:4320")
    expect(validateWorkerEnv(state.env).apiOrigin).toBe("https://api.example")
  })

  it("requires independent admission and coordinator credentials", () => {
    const state = environment()
    expect(() => validateWorkerEnv({ ...state.env, COLLABORATION_ADMISSION_SERVICE_TOKEN: secret }))
      .toThrow("Sync service credentials must be independent")
  })

  it("CLOUD-SYNC-CONTAINER-001 exposes staging only after the private Container path exists", () => {
    const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"))
    expect(config.workers_dev).toBe(false)
    expect(config.routes).toBeUndefined()
    expect(config.env.preview.name).toBe("comp-canvas-sync-preview")
    expect(config.env.preview.routes).toEqual([{ pattern: "sync-staging.canvas.ripgrim.com", custom_domain: true }])
    expect(config.env.preview.services).toEqual([{ binding: "SYNC_COORDINATOR", service: "comp-canvas-sync-coordinator-preview" }])
    expect(config.env.production).toBeUndefined()
  })
})
