import { describe, expect, it, vi } from "vitest"
import runtime, { RoomContainer } from "../src/index.js"
import { validateRuntimeEnv } from "../src/config.js"
import type { SyncRuntimeEnv } from "../src/config.js"

const fileId = "c4964764-a27f-4345-8b6a-eada5b77f339"
const generationId = "3d6c7f8e-20bc-47eb-b264-d190a9239e70"
const url = `https://runtime.internal/sync/${fileId}/${generationId}?clientId=tab-1&connectionNonce=${"n".repeat(24)}`
const secret = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString("base64url")

function environment(fetcher = vi.fn(async () => new Response(null, { status: 200 }))): SyncRuntimeEnv {
  return {
    DATABASE_URL: "postgresql://user:password@database.example:6432/canvas?sslmode=verify-full",
    SYNC_ROOM_TICKET_SECRET: secret,
    ALLOWED_ORIGINS: "https://staging.canvas.example,https://login-staging.canvas.example",
    SYNC_CONTAINER_INACTIVITY_MS: "600000",
    ROOM_CONTAINERS: { idFromName: name => name, get: () => ({ fetch: fetcher }) },
  }
}

describe("staging room runtime", () => {
  it("routes one file generation to one stable private container object", async () => {
    const fetcher = vi.fn(async () => ({ status: 101 } as Response))
    const response = await runtime.fetch(new Request(url), environment(fetcher))
    expect(response.status).toBe(101)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it("starts with only the room runtime secrets and forwards the WebSocket after readiness", async () => {
    const requests: Array<Request | string> = []
    const start = vi.fn()
    const fetcher = vi.fn(async (request: Request | string) => {
      requests.push(request)
      return typeof request === "string" ? new Response(null, { status: 200 }) : ({ status: 101 } as Response)
    })
    const env = environment()
    const context = {
      container: { running: false, start, setInactivityTimeout: vi.fn(async () => undefined), getTcpPort: () => ({ fetch: fetcher }) },
      blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
    }
    const response = await new RoomContainer(context, env).fetch(new Request(url))
    expect(response.status).toBe(101)
    expect(start).toHaveBeenCalledOnce()
    const passed = start.mock.calls[0]![0]!.env
    expect(passed).toMatchObject({ HOST: "0.0.0.0", PORT: "4325", SYNC_HOST_MAX_ROOMS: "1", SYNC_ROOM_ALLOW_NON_LOOPBACK: "true" })
    expect(passed.DATABASE_URL).toBe(env.DATABASE_URL)
    expect(passed.SYNC_ROOM_TICKET_SECRET).toBe(env.SYNC_ROOM_TICKET_SECRET)
    expect(requests).toHaveLength(2)
    expect(new URL((requests[1] as Request).url).hostname).toBe("container")
  })

  it("fails closed on missing secrets, invalid routes, and insecure origins", async () => {
    const env = environment()
    expect(() => validateRuntimeEnv({ ...env, DATABASE_URL: "" })).toThrow("DATABASE_URL")
    expect(() => validateRuntimeEnv({ ...env, ALLOWED_ORIGINS: "http://staging.canvas.example" })).toThrow("ALLOWED_ORIGINS")
    expect((await runtime.fetch(new Request("https://runtime.internal/unknown"), env)).status).toBe(404)
  })
})
