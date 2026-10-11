import { requestCollaborationAdmission } from "./admission.js"
import { sealInternalAdmission } from "./admission-envelope.js"
import { validateWorkerEnv } from "./config.js"
import type { SyncWorkerEnv } from "./config.js"
import { parseSyncRoute, scopedRoomName } from "./route.js"
import { validateWebSocketHandshake } from "./websocket.js"

const internalAdmissionHeader = "X-Canvas-Sync-Admission"
const internalRoomHeader = "X-Canvas-Sync-Room"
const requestIdHeader = "X-Canvas-Request-Id"
const internalAdmissionLifetimeMs = 15_000

function json(body: unknown, status: number, requestId?: string): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", ...(requestId ? { [requestIdHeader]: requestId } : {}) } })
}

function error(code: string, message: string, status: number, requestId?: string): Response {
  return json({ error: { code, message, ...(requestId ? { requestId } : {}) } }, status, requestId)
}

function admissionFailure(status: number, requestId: string): Response {
  if (status === 401) return error("unauthorized", "Sign in required.", 401, requestId)
  if (status === 403) return error("forbidden", "File access denied.", 403, requestId)
  if (status === 404) return error("not_found", "File not found.", 404, requestId)
  if (status === 426) return error("incompatible_build", "Update required.", 426, requestId)
  return error("service_unavailable", "Sync is unavailable.", 503, requestId)
}

function requestReference(request: Request): string {
  const value = request.headers.get("CF-Ray")
  return value && /^[A-Za-z0-9:._-]{1,128}$/.test(value) ? value : crypto.randomUUID()
}

export async function handleRequest(request: Request, env: SyncWorkerEnv): Promise<Response> {
  const configuration = validateWorkerEnv(env)
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/healthz" && url.search === "") return json({ ok: true }, 200)
  const route = parseSyncRoute(request.url)
  if (!route) return error("not_found", "Not found.", 404)
  const handshake = validateWebSocketHandshake(request)
  if (!handshake) return error("upgrade_required", "WebSocket upgrade required.", 426)
  const origin = request.headers.get("Origin")
  if (!origin || !configuration.allowedOrigins.has(origin)) return error("forbidden", "Origin not allowed.", 403)

  const requestId = requestReference(request)
  const admitted = await requestCollaborationAdmission({ apiOrigin: configuration.apiOrigin, serviceToken: env.COLLABORATION_ADMISSION_SERVICE_TOKEN, buildId: configuration.buildId, fileId: route.fileId, clientId: route.clientId, requestId, request })
  if (!admitted.admission) return admissionFailure(admitted.response.status, requestId)
  const roomName = scopedRoomName(route.fileId, admitted.admission.claims.generationId)
  const nowUnixMs = Date.now()
  const internalAdmission = await sealInternalAdmission({ admissionId: crypto.randomUUID(), roomName, origin, clientId: route.clientId, requestId, claims: admitted.admission.claims, issuedAtUnixMs: nowUnixMs, expiresAtUnixMs: nowUnixMs + internalAdmissionLifetimeMs }, configuration.coordinatorSecret)
  const headers = new Headers({
    "Connection": "Upgrade",
    "Origin": origin,
    "Upgrade": "websocket",
    "Sec-WebSocket-Key": request.headers.get("Sec-WebSocket-Key")!,
    "Sec-WebSocket-Version": "13",
    [internalAdmissionHeader]: internalAdmission,
    [internalRoomHeader]: roomName,
    [requestIdHeader]: requestId,
  })
  if (handshake.protocol) headers.set("Sec-WebSocket-Protocol", handshake.protocol)
  return env.SYNC_ROOMS.get(env.SYNC_ROOMS.idFromName(roomName)).fetch(new Request(request.url, { method: "GET", headers }))
}

export default {
  async fetch(request: Request, env: SyncWorkerEnv): Promise<Response> {
    const requestId = requestReference(request)
    try { return await handleRequest(request, env) }
    catch (reason) {
      console.error(JSON.stringify({ level: "error", event: "sync_worker_request_failed", requestId, path: new URL(request.url).pathname, reason: reason instanceof Error ? reason.message : "Unknown error" }))
      return error("service_unavailable", "Sync is unavailable.", 503, requestId)
    }
  },
}
