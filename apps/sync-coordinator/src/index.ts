import { validateCoordinatorEnv } from "./config.js"
import type { SyncCoordinatorEnv } from "./config.js"
import type { DurableObjectContext } from "./platform.js"
import type { DurableObjectStorage } from "./platform.js"
import { consumeAdmission } from "./admission-replay.js"
import { parseSyncRoute, scopedRoomName } from "./route.js"
import { mintRoomTicket, openInternalAdmission } from "./tickets.js"
import { validateWebSocketHandshake } from "./websocket.js"

const admissionHeader = "X-Canvas-Sync-Admission"
const roomHeader = "X-Canvas-Sync-Room"
const requestIdHeader = "X-Canvas-Request-Id"
const json = (code: string, message: string, status: number): Response => new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" } })

async function verifiedAdmission(request: Request, env: SyncCoordinatorEnv, nowUnixMs: number) {
  const configuration = validateCoordinatorEnv(env)
  const route = parseSyncRoute(request.url)
  const handshake = validateWebSocketHandshake(request)
  const origin = request.headers.get("Origin")
  const expectedRoom = request.headers.get(roomHeader)
  const token = request.headers.get(admissionHeader)
  if (!route || !handshake || !origin || !configuration.allowedOrigins.has(origin) || !expectedRoom || !token) return null
  const admission = await openInternalAdmission(token, configuration.coordinatorSecret, nowUnixMs)
  if (!admission || admission.origin !== origin || admission.clientId !== route.clientId || admission.claims.fileId !== route.fileId || admission.roomName !== expectedRoom
    || scopedRoomName(route.fileId, admission.claims.generationId) !== expectedRoom) return null
  return { configuration, route, handshake, admission, expectedRoom, token }
}

export async function handleCoordinatorRequest(request: Request, env: SyncCoordinatorEnv, nowUnixMs = Date.now()): Promise<Response> {
  const verified = await verifiedAdmission(request, env, nowUnixMs)
  if (!verified) return json("forbidden", "WebSocket upgrade rejected.", 403)
  const headers = new Headers({
    "Connection": "Upgrade", "Origin": verified.admission.origin, "Upgrade": "websocket",
    "Sec-WebSocket-Key": request.headers.get("Sec-WebSocket-Key")!, "Sec-WebSocket-Version": "13",
    [admissionHeader]: verified.token, [roomHeader]: verified.expectedRoom, [requestIdHeader]: verified.admission.requestId,
  })
  if (verified.handshake.protocol) headers.set("Sec-WebSocket-Protocol", verified.handshake.protocol)
  return env.SYNC_ROOMS.get(env.SYNC_ROOMS.idFromName(verified.expectedRoom)).fetch(new Request(request.url, { method: "GET", headers }))
}

export type RuntimeFetch = (request: Request) => Promise<Response>
export async function proxyRoomUpgrade(input: Readonly<{ request: Request; env: SyncCoordinatorEnv; storage: DurableObjectStorage; runtimeFetch?: RuntimeFetch; nowUnixMs?: number }>): Promise<Response> {
  const nowUnixMs = input.nowUnixMs ?? Date.now()
  const verified = await verifiedAdmission(input.request, input.env, nowUnixMs)
  if (!verified) return json("forbidden", "WebSocket upgrade rejected.", 403)
  if (!await consumeAdmission(input.storage, verified.admission.admissionId, verified.admission.expiresAtUnixMs, nowUnixMs)) return json("forbidden", "WebSocket upgrade rejected.", 403)
  const connectionNonce = crypto.randomUUID().replace(/-/g, "")
  const roomTicket = await mintRoomTicket({ ...verified.admission.claims, expiresAtUnixMs: nowUnixMs + verified.configuration.ticketTtlMs, clientId: verified.route.clientId, connectionNonce }, verified.configuration.ticketSecret)
  const runtimeUrl = new URL(`/sync/${encodeURIComponent(verified.route.fileId)}/${encodeURIComponent(verified.admission.claims.generationId)}`, verified.configuration.runtimeOrigin)
  runtimeUrl.searchParams.set("clientId", verified.route.clientId); runtimeUrl.searchParams.set("connectionNonce", connectionNonce)
  const headers = new Headers({ "Authorization": `Bearer ${roomTicket}`, "Connection": "Upgrade", "Origin": verified.admission.origin, "Upgrade": "websocket", "Sec-WebSocket-Key": input.request.headers.get("Sec-WebSocket-Key")!, "Sec-WebSocket-Version": "13", [requestIdHeader]: verified.admission.requestId })
  if (verified.handshake.protocol) headers.set("Sec-WebSocket-Protocol", verified.handshake.protocol)
  const runtimeFetch = input.runtimeFetch ?? (input.env.SYNC_RUNTIME ? request => input.env.SYNC_RUNTIME!.fetch(request) : request => fetch(request))
  const response = await runtimeFetch(new Request(runtimeUrl, { method: "GET", headers }))
  return response.status === 101 ? response : json("room_unavailable", "File is busy.", 503)
}

export class FileSyncRoom {
  readonly #env: SyncCoordinatorEnv
  readonly #storage: DurableObjectStorage
  constructor(context: DurableObjectContext, env: SyncCoordinatorEnv) { validateCoordinatorEnv(env); this.#env = env; this.#storage = context.storage }
  fetch(request: Request): Promise<Response> { return proxyRoomUpgrade({ request, env: this.#env, storage: this.#storage }) }
}

export default { async fetch(request: Request, env: SyncCoordinatorEnv): Promise<Response> { try { return await handleCoordinatorRequest(request, env) } catch { return json("service_unavailable", "Sync is unavailable.", 503) } } }
