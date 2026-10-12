import { collaborationProtocolEpoch } from '@canvas/sync-protocol'

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
const routePattern = new RegExp(`^/sync/(${uuid})/(${uuid})$`, "i")
const clientIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const connectionNoncePattern = /^[A-Za-z0-9_-]{16,512}$/
const runtimeQueryKeys = Object.freeze(["clientId", "connectionNonce"] as const)

export function parseRuntimeRoute(url: string): Readonly<{ fileId: string; generationId: string; roomName: string }> | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  const match = routePattern.exec(parsed.pathname)
  const keys = [...parsed.searchParams.keys()]
  if (!match
    || keys.length !== runtimeQueryKeys.length
    || keys.some(key => !runtimeQueryKeys.includes(key as (typeof runtimeQueryKeys)[number]))
    || runtimeQueryKeys.some(key => parsed.searchParams.getAll(key).length !== 1)) return null
  const clientId = parsed.searchParams.get("clientId")
  const connectionNonce = parsed.searchParams.get("connectionNonce")
  if (!clientId || !clientIdPattern.test(clientId) || !connectionNonce || !connectionNoncePattern.test(connectionNonce)) return null
  const fileId = match[1]!.toLowerCase()
  const generationId = match[2]!.toLowerCase()
  return Object.freeze({ fileId, generationId, roomName: `sync:${collaborationProtocolEpoch}:${fileId}:${generationId}` })
}
