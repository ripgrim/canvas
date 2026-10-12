import { readFileSync } from "node:fs"
import { collaborationProtocolEpoch, collaborationWebSocketProtocol } from "@canvas/sync-protocol"
import { afterEach, describe, expect, it, vi } from "vitest"
import worker, { handleRequest } from "../src/index.js"
import { validateWorkerEnv } from "../src/config.js"
import type { SyncWorkerEnv } from "../src/config.js"
import { parseWebSocketProtocols } from "../src/websocket.js"

const fileId = "c4964764-a27f-4345-8b6a-eada5b77f339"
const generationId = "3d6c7f8e-20bc-47eb-b264-d190a9239e70"
const origin = "https://canvas.example"
const secret = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString("base64url")

function handshake(overrides: Record<string, string | null> = {}, path = `/sync/${fileId}?tabId=tab-1`, method = "GET"): Request {
  const headers = new Headers({ Origin: origin, Upgrade: "websocket", Connection: "keep-alive, Upgrade", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Protocol": collaborationWebSocketProtocol, Cookie: "session=private", Authorization: "Bearer browser" })
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) headers.delete(name)
    else headers.set(name, value)
  }
  return new Request(`https://sync.example${path}`, { method, headers })
}

function environment() {
  const requests: Request[] = []
  const env: SyncWorkerEnv = {
    API_ORIGIN: "https://api.example",
    COLLABORATION_ADMISSION_SERVICE_TOKEN: "a".repeat(32),
    COLLABORATION_BUILD_ID: "0.1.0",
    SYNC_COORDINATOR_INTERNAL_SECRET: secret,
    ALLOWED_ORIGINS: origin,
    SYNC_ROOMS: {
      idFromName: name => name,
      get: id => ({ async fetch(request) { expect(id).toBe(`sync:4:${fileId}:${generationId}`); requests.push(request); return { status: 101 } as Response } }),
    },
  }
  return { env, requests }
}

function mockAdmission(status = 200, body: unknown = { claims: { subjectId: "user:1", displayName: "Alpha", avatarUrl: "https://images.example/alpha.png", fileId, role: "owner", generationId, protocolEpoch: 4, accessEpoch: "1" }, generation: { status: "active" }, compatibility: { status: "compatible", protocolEpoch: 4, buildId: "0.1.0" } }) {
  const requests: Request[] = []
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => { requests.push(new Request(input, init)); return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }) }))
  return requests
}

afterEach(() => vi.unstubAllGlobals())

describe("public RFC6455 admission", () => {
  it.each([
    ["the exact epoch-4 token", "canvas-sync-v4", "canvas-sync-v4"],
    ["an absent header", null, null],
    ["an empty header", "", null],
    ["a leading empty member", ",canvas-sync-v4", null],
    ["a trailing empty member", "canvas-sync-v4,", null],
    ["consecutive empty members", "canvas-sync-v4,,canvas-sync-v4", null],
    ["a whitespace-only member", "canvas-sync-v4,   ", null],
    ["leading whitespace", " canvas-sync-v4", null],
    ["trailing whitespace", "canvas-sync-v4 ", null],
    ["a duplicate", "canvas-sync-v4,canvas-sync-v4", null],
    ["a mixed offer", "canvas-sync-v4,canvas-sync-v3", null],
    ["an unknown offer", "canvas-sync-v5", null],
  ])("CLOUD-SYNC-SCHEMA-001-C4-WORKER raw parser handles %s without its own normalization or downgrade", (_name, offered, expected) => {
    expect(parseWebSocketProtocols(offered)).toBe(expected)
  })

  it.each([" canvas-sync-v4", "canvas-sync-v4 "])("CLOUD-SYNC-SCHEMA-001-C4-WORKER accepts legal surrounding OWS only after Fetch canonicalization: %j", async offered => {
    const api = mockAdmission(); const state = environment()
    const request = handshake({ "Sec-WebSocket-Protocol": offered })
    expect(request.headers.get("Sec-WebSocket-Protocol")).toBe("canvas-sync-v4")
    expect((await handleRequest(request, state.env)).status).toBe(101)
    expect(api).toHaveLength(1); expect(state.requests).toHaveLength(1)
    expect(await api[0]!.json()).toMatchObject({ protocolEpoch: 4, webSocketProtocol: "canvas-sync-v4" })
  })

  it("CLOUD-SYNC-AUTH-001-C4-WORKER admits only the epoch-4 handshake through the server-selected coordinator binding", async () => {
    expect(collaborationProtocolEpoch).toBe(4)
    expect(collaborationWebSocketProtocol).toBe("canvas-sync-v4")
    const api = mockAdmission(); const state = environment()
    expect((await handleRequest(handshake(), state.env)).status).toBe(101)
    expect(api).toHaveLength(1); expect(state.requests).toHaveLength(1)
    expect(await api[0]!.json()).toEqual({ fileId, clientId: 'tab-1', protocolEpoch: 4, webSocketProtocol: 'canvas-sync-v4', buildId: '0.1.0' })
    expect(api[0]!.headers.get("Origin")).toBe(origin)
    expect(api[0]!.headers.get("Authorization")).toBe("Bearer browser")
    expect(api[0]!.headers.get("Cookie")).toBe("session=private")
    expect(api[0]!.headers.get("X-Canvas-Collaboration-Token")).toBe(state.env.COLLABORATION_ADMISSION_SERVICE_TOKEN)
    const forwarded = state.requests[0]!
    expect(forwarded.headers.get("Cookie")).toBeNull()
    expect(forwarded.headers.get("Authorization")).toBeNull()
    expect(forwarded.headers.get("X-Canvas-Collaboration-Token")).toBeNull()
    expect(forwarded.headers.get("Sec-WebSocket-Key")).toBe("dGhlIHNhbXBsZSBub25jZQ==")
    const internalAdmission = forwarded.headers.get("X-Canvas-Sync-Admission")!
    const envelope = JSON.parse(Buffer.from(internalAdmission.split(".")[0]!, "base64url").toString("utf8"))
    expect(envelope.admissionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(envelope).toMatchObject({ roomName: `sync:4:${fileId}:${generationId}`, origin, clientId: "tab-1", claims: { fileId, generationId, protocolEpoch: 4, buildId: "0.1.0", role: "owner" } })
  })

  it.each([
    ["method", handshake({}, undefined, "POST")],
    ["Upgrade", handshake({ Upgrade: "" })],
    ["Connection", handshake({ Connection: "keep-alive" })],
    ["version", handshake({ "Sec-WebSocket-Version": "12" })],
    ["missing key", handshake({ "Sec-WebSocket-Key": "" })],
    ["malformed key", handshake({ "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25j" })],
    ["epoch-3 protocol", handshake({ "Sec-WebSocket-Protocol": "canvas-sync-v3" })],
    ["unknown protocol", handshake({ "Sec-WebSocket-Protocol": "evil" })],
    ["mixed epoch-4 and epoch-3 protocols", handshake({ "Sec-WebSocket-Protocol": "canvas-sync-v4, canvas-sync-v3" })],
    ["duplicate epoch-4 protocols", handshake({ "Sec-WebSocket-Protocol": "canvas-sync-v4, canvas-sync-v4" })],
    ["absent protocol", handshake({ "Sec-WebSocket-Protocol": null })],
    ["empty protocol", handshake({ "Sec-WebSocket-Protocol": "" })],
    ["leading empty protocol member", handshake({ "Sec-WebSocket-Protocol": ",canvas-sync-v4" })],
    ["trailing empty protocol member", handshake({ "Sec-WebSocket-Protocol": "canvas-sync-v4," })],
    ["consecutive empty protocol members", handshake({ "Sec-WebSocket-Protocol": "canvas-sync-v4,,canvas-sync-v4" })],
    ["whitespace-only protocol member", handshake({ "Sec-WebSocket-Protocol": "canvas-sync-v4,   " })],
    ["internal protocol whitespace", handshake({ "Sec-WebSocket-Protocol": "canvas-sync- v4" })],
  ])("CLOUD-SYNC-SCHEMA-001-C4-WORKER rejects an invalid %s before admission without downgrade", async (_name, request) => {
    const api = mockAdmission(); const state = environment()
    expect((await handleRequest(request, state.env)).status).toBe(426)
    expect(api).toHaveLength(0); expect(state.requests).toHaveLength(0)
  })

  it("CLOUD-SYNC-DO-SEC-001-C4-WORKER rejects hostile origins and client-selected routing before forwarding credentials", async () => {
    const api = mockAdmission(); const state = environment()
    const hostileOrigin = await handleRequest(handshake({ Origin: "https://evil.example" }), state.env)
    expect(hostileOrigin.status).toBe(403)
    expect(await hostileOrigin.json()).toEqual({ error: { code: "forbidden", message: "Origin not allowed." } })
    expect(JSON.stringify(await (await handleRequest(handshake({ Origin: "https://evil.example" }), state.env)).json())).not.toContain(origin)
    expect((await handleRequest(handshake({ Origin: "https://canvas.example.evil.test" }), state.env)).status).toBe(403)
    expect((await handleRequest(handshake({}, `/sync/${fileId}?tabId=tab-1&generationId=${generationId}`), state.env)).status).toBe(404)
    expect((await handleRequest(handshake({}, `/sync/${fileId}?tabId=tab-1&tabId=tab-2`), state.env)).status).toBe(404)
    expect(api).toHaveLength(0); expect(state.requests).toHaveLength(0)
  })

  it("CLOUD-SYNC-DO-SEC-001-C4-WORKER keeps the staging login origin outside admission", async () => {
    const api = mockAdmission(); const state = environment()
    const staging = { ...state.env, ALLOWED_ORIGINS: "https://staging.canvas.ripgrim.com" }
    const response = await handleRequest(handshake({ Origin: "https://login-staging.canvas.ripgrim.com" }), staging)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: { code: "forbidden", message: "Origin not allowed." } })
    expect(api).toHaveLength(0); expect(state.requests).toHaveLength(0)
  })

  it("rejects missing Origin and malformed route identities", async () => {
    const api = mockAdmission(); const state = environment()
    expect((await handleRequest(handshake({ Origin: "" }), state.env)).status).toBe(403)
    expect((await handleRequest(handshake({}, "/sync/not-a-file?tabId=tab-1"), state.env)).status).toBe(404)
    expect((await handleRequest(handshake({}, `/sync/${fileId}?tabId=bad%20tab`), state.env)).status).toBe(404)
    expect(api).toHaveLength(0)
  })

  it.each([
    [401, "unauthorized", "Sign in required."],
    [403, "forbidden", "File access denied."],
    [404, "not_found", "File not found."],
    [426, "incompatible_build", "Update required."],
    [500, "service_unavailable", "Sync is unavailable."],
  ])("CLOUD-SYNC-DO-SEC-001-C4-WORKER maps admission status %i to a stable public error", async (status, code, message) => {
    mockAdmission(status, { error: { code: "private_upstream_code", message: "private upstream detail" } }); const state = environment()
    const response = await handleRequest(handshake(), state.env, "request-stable")
    expect(response.status).toBe(status >= 500 ? 503 : status)
    expect(await response.json()).toEqual({ error: { code, message, requestId: "request-stable" } })
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
    const claims = { subjectId: "user:1", displayName: "Alpha", avatarUrl: null, fileId, role: "owner", generationId, protocolEpoch: 4, accessEpoch: "1", ...identity }
    mockAdmission(200, { claims, generation: { status: "active" }, compatibility: { status: "compatible", protocolEpoch: 4, buildId: "0.1.0" } })
    const state = environment()
    expect((await handleRequest(handshake(), state.env)).status).toBe(503)
    expect(state.requests).toHaveLength(0)
  })

  it("OBS-SYNC-001-C4-WORKER fails closed with one request reference when admission is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline") }))
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const state = environment()
    const response = await worker.fetch(handshake({ "CF-Ray": "ray-test" }), state.env)
    expect(response.status).toBe(503)
    expect(response.headers.get("X-Canvas-Request-Id")).toBe("ray-test")
    expect(await response.json()).toEqual({ error: { code: "service_unavailable", message: "Sync is unavailable.", requestId: "ray-test" } })
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('"requestId":"ray-test"'))
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
    expect(config.durable_objects.bindings).toEqual([
      { name: "SYNC_ROOMS", class_name: "LocalFileSyncRoom", script_name: "comp-canvas-sync-coordinator" },
    ])
    expect(config.env.preview.name).toBe("comp-canvas-sync-preview")
    expect(config.env.preview.routes).toEqual([{ pattern: "sync-staging.canvas.ripgrim.com", custom_domain: true }])
    expect(config.env.preview.vars.ALLOWED_ORIGINS).toBe("https://staging.canvas.ripgrim.com")
    expect(config.env.preview.vars.ALLOWED_ORIGINS).not.toContain("login-staging.canvas.ripgrim.com")
    expect(config.env.preview.services).toBeUndefined()
    expect(config.env.preview.durable_objects.bindings).toEqual([
      { name: "SYNC_ROOMS", class_name: "FileSyncRoom", script_name: "comp-canvas-sync-coordinator-preview" },
    ])
    expect(config.env.production).toBeUndefined()
  })
})
