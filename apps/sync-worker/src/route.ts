import { collaborationProtocolEpoch } from "@canvas/sync-protocol"

const fileIdentity = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const clientIdentity = /^[A-Za-z0-9:._-]{1,128}$/

export type SyncRoute = Readonly<{ fileId: string; clientId: string }>

export function parseSyncRoute(input: string): SyncRoute | null {
  let url: URL
  try { url = new URL(input) } catch { return null }
  const match = /^\/sync\/([^/]+)$/.exec(url.pathname)
  if (!match) return null
  let fileId: string
  try { fileId = decodeURIComponent(match[1]!) } catch { return null }
  const entries = [...url.searchParams.entries()]
  if (entries.length !== 1 || entries[0]?.[0] !== "tabId") return null
  const clientId = entries[0][1]
  return fileIdentity.test(fileId) && clientIdentity.test(clientId) ? Object.freeze({ fileId, clientId }) : null
}

export function scopedRoomName(fileId: string, generationId: string): string {
  if (!fileIdentity.test(fileId) || !fileIdentity.test(generationId)) throw new Error("Room identity is invalid.")
  return `sync:${collaborationProtocolEpoch}:${fileId}:${generationId}`
}
