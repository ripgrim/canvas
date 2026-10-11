import type { SyncCoordinatorEnv } from "./config.js"
import { handleCoordinatorRequest } from "./index.js"

const json = (code: string, message: string, status: number): Response => new Response(JSON.stringify({ error: { code, message } }), {
  status,
  headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" },
})

export { FileSyncRoom } from "./room-container.js"

export default {
  async fetch(request: Request, env: SyncCoordinatorEnv): Promise<Response> {
    try { return await handleCoordinatorRequest(request, env) }
    catch { return json("service_unavailable", "Sync is unavailable.", 503) }
  },
}
