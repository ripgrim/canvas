import { validateRuntimeEnv } from "./config.js"
import type { SyncRuntimeEnv } from "./config.js"
import type { DurableObjectContext } from "./platform.js"
import { parseRuntimeRoute } from "./route.js"

const port = 4325
const readinessAttempts = 100
const readinessDelayMs = 200

const json = (body: unknown, status: number): Response => new Response(JSON.stringify(body), { status, headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" } })
const wait = (durationMs: number): Promise<void> => new Promise(resolve => setTimeout(resolve, durationMs))

export class RoomContainer {
  readonly #context: DurableObjectContext
  readonly #env: SyncRuntimeEnv
  #starting: Promise<void> | undefined

  constructor(context: DurableObjectContext, env: SyncRuntimeEnv) {
    validateRuntimeEnv(env)
    if (!context.container) throw new Error("Room container binding is unavailable.")
    this.#context = context
    this.#env = env
    if (context.container.running) void context.blockConcurrencyWhile(() => context.container!.setInactivityTimeout(validateRuntimeEnv(env).inactivityMs))
  }

  async fetch(request: Request): Promise<Response> {
    if (!parseRuntimeRoute(request.url)) return json({ error: { code: "not_found", message: "Not found." } }, 404)
    this.#starting ??= this.#start().finally(() => { this.#starting = undefined })
    await this.#starting
    const url = new URL(request.url)
    url.protocol = "http:"
    url.host = "container"
    const forwarded = new Request(url, request)
    forwarded.headers.delete("host")
    return this.#context.container!.getTcpPort(port).fetch(forwarded)
  }

  async #start(): Promise<void> {
    const container = this.#context.container!
    const configuration = validateRuntimeEnv(this.#env)
    if (!container.running) {
      container.start({ env: {
        DATABASE_URL: configuration.databaseUrl,
        SYNC_ROOM_TICKET_SECRET: configuration.ticketSecret,
        ALLOWED_ORIGINS: configuration.allowedOrigins,
        SYNC_ROOM_CHECKPOINT_DIR: "/tmp/canvas-checkpoints",
        HOST: "0.0.0.0",
        PORT: String(port),
        SYNC_HOST_MAX_ROOMS: "1",
        SYNC_ROOM_ALLOW_NON_LOOPBACK: "true",
      } })
    }
    await container.setInactivityTimeout(configuration.inactivityMs)
    const runtime = container.getTcpPort(port)
    let lastError: unknown
    for (let attempt = 0; attempt < readinessAttempts; attempt += 1) {
      try {
        const response = await runtime.fetch("http://container/healthz", { signal: AbortSignal.timeout(1_000) })
        await response.body?.cancel()
        if (!response.ok) throw new Error(`Room container health check returned ${response.status}.`)
        return
      } catch (error) {
        lastError = error
        await wait(readinessDelayMs)
      }
    }
    throw new Error("Room container did not become ready.", { cause: lastError })
  }
}

export default {
  async fetch(request: Request, env: SyncRuntimeEnv): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/healthz") return json({ ok: true }, 200)
    const route = parseRuntimeRoute(request.url)
    if (!route) return json({ error: { code: "not_found", message: "Not found." } }, 404)
    return env.ROOM_CONTAINERS.get(env.ROOM_CONTAINERS.idFromName(route.roomName)).fetch(request)
  },
}
