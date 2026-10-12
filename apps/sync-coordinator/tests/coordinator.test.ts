import { readFileSync } from "node:fs"
import { maxCollaborationAvatarUrlBytes, maxRoomTicketLength } from "@canvas/sync-protocol"
import { afterEach, describe, expect, it, vi } from "vitest"
import { handleCoordinatorRequest, proxyRoomUpgrade } from "../src/index.js"
import { consumeAdmission } from "../src/admission-replay.js"
import { validateCoordinatorEnv } from "../src/config.js"
import type { SyncCoordinatorEnv } from "../src/config.js"
import type { DurableObjectStorage, DurableObjectTransaction } from "../src/platform.js"

const fileId = "c4964764-a27f-4345-8b6a-eada5b77f339"
const generationId = "3d6c7f8e-20bc-47eb-b264-d190a9239e70"
const roomName = `sync:2:${fileId}:${generationId}`
const origin = "https://canvas.example"
const secretBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const secret = Buffer.from(secretBytes).toString("base64url")
type AdmissionEnvelope = Readonly<{
  admissionId: string
  roomName: string
  origin: string
  clientId: string
  requestId: string
  claims: Readonly<{ subjectId: string; displayName: string; avatarUrl: string | null; fileId: string; role: "owner" | "viewer"; generationId: string; protocolEpoch: 2; buildId: string; accessEpoch: string }>
  issuedAtUnixMs: number
  expiresAtUnixMs: number
}>

async function signAdmission(now = Date.now(), overrides: Partial<Omit<AdmissionEnvelope, "claims">> & Readonly<{ claims?: Partial<AdmissionEnvelope["claims"]> }> = {}): Promise<string> {
  const { claims: claimOverrides, ...fields } = overrides
  const envelope: AdmissionEnvelope = {
    admissionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", roomName, origin, clientId: "tab-1", requestId: "request-1",
    claims: { subjectId: "user:1", displayName: "Alpha", avatarUrl: "https://images.example/alpha.png", fileId, role: "owner", generationId, protocolEpoch: 2, buildId: "0.1.0", accessEpoch: "1", ...claimOverrides },
    issuedAtUnixMs: now, expiresAtUnixMs: now + 15_000, ...fields,
  }
  const payload = Buffer.from(JSON.stringify(envelope)).toString("base64url")
  const key = await crypto.subtle.importKey("raw", secretBytes.buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`canvas-sync-admission-v1:${payload}`))).toString("base64url")
  return `${payload}.${signature}`
}

async function handshake(overrides: Record<string, string> = {}, method = "GET"): Promise<Request> {
  return new Request(`https://coordinator.internal/sync/${fileId}?tabId=tab-1`, { method, headers: { Origin: origin, Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Protocol": "canvas-sync-v2", "X-Canvas-Sync-Room": roomName, "X-Canvas-Sync-Admission": await signAdmission(), ...overrides } })
}

class FakeStorage implements DurableObjectStorage {
  readonly values = new Map<string, unknown>()
  #tail = Promise.resolve()
  transaction<T>(callback: (transaction: DurableObjectTransaction) => Promise<T>): Promise<T> {
    const result = this.#tail.then(() => callback({
      get: async <V>(key: string) => this.values.get(key) as V | undefined,
      put: async <V>(key: string, value: V) => { this.values.set(key, value) },
    }))
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }
  async list<T>(options: Readonly<{ prefix: string; limit: number }>) { return new Map([...this.values].filter(([key]) => key.startsWith(options.prefix)).slice(0, options.limit)) as Map<string, T> }
  async delete(keys: readonly string[]) { let count = 0; for (const key of keys) if (this.values.delete(key)) count += 1; return count }
}

function environment(runtimeRequests: Request[], storage = new FakeStorage()) {
  let env: SyncCoordinatorEnv
  env = {
    SYNC_COORDINATOR_INTERNAL_SECRET: secret,
    SYNC_ROOM_TICKET_SECRET: Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => 255 - index)).toString("base64url"),
    SYNC_ROOM_RUNTIME_ORIGIN: "http://127.0.0.1:4325",
    SYNC_ROOM_TICKET_TTL_MS: "300000",
    SYNC_CONTAINER_INACTIVITY_MS: "600000",
    DATABASE_URL: "postgresql://user:password@database.example:6432/canvas?sslmode=verify-full",
    ALLOWED_ORIGINS: origin,
    SYNC_ROOMS: { idFromName: name => name, get: () => ({ fetch: request => proxyRoomUpgrade({ request, env, storage }) }) },
  }
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => { runtimeRequests.push(request); return { status: 101 } as Response }))
  return env
}

afterEach(() => vi.unstubAllGlobals())

describe("private coordinator and real DO boundary", () => {
  it("routes a complete handshake through the real DO without API or repository authority", async () => {
    const runtime: Request[] = []; const env = environment(runtime)
    const response = await handleCoordinatorRequest(await handshake(), env)
    expect(response.status).toBe(101)
    expect(runtime).toHaveLength(1)
    expect(Object.keys(env).sort()).toEqual(["ALLOWED_ORIGINS", "DATABASE_URL", "SYNC_CONTAINER_INACTIVITY_MS", "SYNC_COORDINATOR_INTERNAL_SECRET", "SYNC_ROOMS", "SYNC_ROOM_RUNTIME_ORIGIN", "SYNC_ROOM_TICKET_SECRET", "SYNC_ROOM_TICKET_TTL_MS"].sort())
    const proxied = runtime[0]!
    expect(proxied.headers.get("Authorization")).toMatch(/^Bearer [A-Za-z0-9_-]+$/)
    expect(proxied.headers.get("Cookie")).toBeNull()
    expect(proxied.headers.get("X-Canvas-Collaboration-Token")).toBeNull()
    expect(proxied.headers.get("X-Canvas-Sync-Admission")).toBeNull()
    expect(proxied.headers.get("X-Canvas-Sync-Room")).toBeNull()
    expect(proxied.headers.get("Sec-WebSocket-Protocol")).toBe("canvas-sync-v2")
    expect(new URL(proxied.url).pathname).toBe(`/sync/${fileId}/${generationId}`)
    expect(new URL(proxied.url).searchParams.get("clientId")).toBe("tab-1")
    expect(new URL(proxied.url).searchParams.get("connectionNonce")).toMatch(/^[A-Za-z0-9_-]{16,512}$/)
    const roomTicket = proxied.headers.get("Authorization")!.slice("Bearer ".length)
    const ticketBytes = Buffer.from(roomTicket, "base64url")
    const ticketClaims = JSON.parse(ticketBytes.subarray(0, -32).toString("utf8"))
    expect(ticketClaims).toMatchObject({ subjectId: "user:1", displayName: "Alpha", avatarUrl: "https://images.example/alpha.png" })
    expect(ticketClaims).not.toHaveProperty("email")
    expect(JSON.stringify(ticketClaims)).not.toMatch(/API_SERVICE|DATABASE|REPOSITORY|SOURCE/)
  })

  it("CLOUD-SYNC-AUTH-001 consumes an admission once across disconnect and DO object restart", async () => {
    const runtime: Request[] = []
    const storage = new FakeStorage()
    const env = environment(runtime, storage)
    const request = await handshake()

    expect((await handleCoordinatorRequest(request, env)).status).toBe(101)
    expect((await handleCoordinatorRequest(request, env)).status).toBe(403)
    expect(runtime).toHaveLength(1)
    expect(storage.values.size).toBe(1)
  })

  it("CLOUD-SYNC-AUTH-001 bounds expired replay-ledger cleanup work", async () => {
    const storage = new FakeStorage()
    for (let index = 0; index < 80; index += 1) storage.values.set(`admission:expired-${index}`, 999)
    storage.values.set("admission:future", 2_000)

    await expect(consumeAdmission(storage, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 2_000, 1_000)).resolves.toBe(true)
    expect(storage.values.size).toBe(18)
    expect(storage.values.get("admission:future")).toBe(2_000)
    expect(storage.values.get("admission:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toBe(2_000)
  })

  it("CLOUD-SYNC-AUTH-001 mints a parseable bounded ticket for worst-case admitted identity", async () => {
    const runtime: Request[] = []; const env = environment(runtime)
    const maxClientId = "c".repeat(128)
    const avatarPrefix = "https://images.example/"
    const token = await signAdmission(Date.now(), {
      clientId: maxClientId,
      claims: {
        subjectId: "s".repeat(128),
        displayName: "😀".repeat(80),
        avatarUrl: `${avatarPrefix}${"a".repeat(maxCollaborationAvatarUrlBytes - avatarPrefix.length)}`,
        accessEpoch: "9223372036854775807",
      },
    })
    const request = new Request(`https://coordinator.internal/sync/${fileId}?tabId=${maxClientId}`, {
      method: "GET",
      headers: {
        Origin: origin,
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Protocol": "canvas-sync-v2",
        "X-Canvas-Sync-Room": roomName,
        "X-Canvas-Sync-Admission": token,
      },
    })

    expect((await handleCoordinatorRequest(request, env)).status).toBe(101)
    const roomTicket = runtime[0]!.headers.get("Authorization")!.slice("Bearer ".length)
    expect(roomTicket.length).toBeLessThanOrEqual(maxRoomTicketLength)
    const bytes = Buffer.from(roomTicket, "base64url")
    expect(() => JSON.parse(bytes.subarray(0, -32).toString("utf8"))).not.toThrow()
  })

  it.each([
    ["method", {}, "POST"],
    ["Upgrade", { Upgrade: "" }, "GET"],
    ["Connection", { Connection: "close" }, "GET"],
    ["version", { "Sec-WebSocket-Version": "8" }, "GET"],
    ["missing key", { "Sec-WebSocket-Key": "" }, "GET"],
    ["malformed key", { "Sec-WebSocket-Key": "not-base64" }, "GET"],
    ["unknown protocol", { "Sec-WebSocket-Protocol": "other" }, "GET"],
    ["empty protocol", { "Sec-WebSocket-Protocol": "" }, "GET"],
    ["missing Origin", { Origin: "" }, "GET"],
    ["untrusted Origin", { Origin: "https://evil.example" }, "GET"],
  ])("rejects invalid %s at the coordinator before DO routing", async (_name, headers, method) => {
    const runtime: Request[] = []; const env = environment(runtime)
    expect((await handleCoordinatorRequest(await handshake(headers, method), env)).status).toBe(403)
    expect(runtime).toHaveLength(0)
  })

  it("rejects a forged admission capability", async () => {
    const runtime: Request[] = []; const env = environment(runtime)
    const request = await handshake()
    const headers = new Headers(request.headers); headers.set("X-Canvas-Sync-Admission", `${headers.get("X-Canvas-Sync-Admission")}x`)
    expect((await handleCoordinatorRequest(new Request(request, { headers }), env)).status).toBe(403)
    expect(runtime).toHaveLength(0)
  })

  it("rejects independently signed admission scope and lifetime changes", async () => {
    const cases = [
      await signAdmission(Date.now(), { origin: "https://other.example" }),
      await signAdmission(Date.now(), { clientId: "tab-2" }),
      await signAdmission(Date.now(), { roomName: `${roomName}:other` }),
      await signAdmission(Date.now(), { claims: { fileId: "11111111-1111-4111-8111-111111111111" } }),
      await signAdmission(Date.now(), { claims: { displayName: " Alpha " } }),
      await signAdmission(Date.now(), { claims: { displayName: "Al\u202Epha" } }),
      await signAdmission(Date.now(), { claims: { displayName: "Al\u2067pha" } }),
      await signAdmission(Date.now(), { claims: { displayName: "Al\u200Bpha" } }),
      await signAdmission(Date.now(), { claims: { avatarUrl: "http://images.example/alpha.png" } }),
      await signAdmission(Date.now(), { claims: { avatarUrl: `https://images.example/${"a".repeat(2_048)}` } }),
      await signAdmission(Date.now(), { claims: { email: "alpha@example.test" } as never }),
      await signAdmission(Date.now() - 20_000),
      await signAdmission(Date.now(), { expiresAtUnixMs: Date.now() + 60_000 }),
    ]
    for (const token of cases) {
      const runtime: Request[] = []; const env = environment(runtime)
      const request = await handshake()
      const headers = new Headers(request.headers); headers.set("X-Canvas-Sync-Admission", token)
      expect((await handleCoordinatorRequest(new Request(request, { headers }), env)).status).toBe(403)
      expect(runtime).toHaveLength(0)
    }
  })

  it("fails closed when the room runtime is unavailable", async () => {
    const runtime: Request[] = []; const env = environment(runtime)
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => { runtime.push(request); return new Response("offline", { status: 503 }) }))
    expect((await handleCoordinatorRequest(await handshake(), env)).status).toBe(503)
    expect(runtime).toHaveLength(1)
  })

  it("requires independent coordinator and room-ticket credentials", () => {
    const runtime: Request[] = []; const env = environment(runtime)
    expect(() => validateCoordinatorEnv({ ...env, SYNC_ROOM_TICKET_SECRET: env.SYNC_COORDINATOR_INTERNAL_SECRET }))
      .toThrow("Sync service credentials must be independent")
  })

  it("CLOUD-SYNC-CONTAINER-001 binds staging only to the private room runtime", () => {
    const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"))
    expect(config.workers_dev).toBe(false)
    expect(config.routes).toBeUndefined()
    expect(config.main).toBe("src/worker.ts")
    expect(config.containers).toEqual([expect.objectContaining({ name: "comp-canvas-sync-room-coordinator-preview", class_name: "FileSyncRoom", image: "../sync-room-core/Dockerfile", max_instances: 10 })])
    expect(config.durable_objects.bindings).toEqual([{ name: "SYNC_ROOMS", class_name: "LocalFileSyncRoom" }])
    expect(config.env.preview.name).toBe("comp-canvas-sync-coordinator-preview")
    expect(config.env.preview.containers).toEqual(config.containers)
    expect(config.env.preview.services).toBeUndefined()
    expect(config.env.preview.durable_objects.bindings).toEqual([{ name: "SYNC_ROOMS", class_name: "FileSyncRoom" }])
    expect(config.env.production).toBeUndefined()
  })

  it("CLOUD-SYNC-CONTAINER-001 sends an admitted upgrade through the local container proxy", async () => {
    const runtime: Request[] = []
    const directEnv = environment([])

    expect((await proxyRoomUpgrade({
      request: await handshake(),
      env: directEnv,
      storage: new FakeStorage(),
      runtimeFetch: async request => { runtime.push(request); return { status: 101 } as Response },
    })).status).toBe(101)
    expect(runtime).toHaveLength(1)
  })

  it("CLOUD-SYNC-CONTAINER-002 reports runtime outages separately from room capacity", async () => {
    const unavailable = await proxyRoomUpgrade({
      request: await handshake(),
      env: environment([]),
      storage: new FakeStorage(),
      runtimeFetch: async () => new Response("offline", { status: 503 }),
    })
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({ error: { code: "room_unavailable", message: "Collaboration service is unavailable." } })

    const capacity = await proxyRoomUpgrade({
      request: await handshake(),
      env: environment([]),
      storage: new FakeStorage(),
      runtimeFetch: async () => new Response("full", { status: 429 }),
    })
    expect(capacity.status).toBe(429)
    expect(await capacity.json()).toEqual({ error: { code: "capacity_refused", message: "Room capacity is unavailable." } })
  })
})
