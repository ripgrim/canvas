const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
const routePattern = new RegExp(`^/sync/(${uuid})/(${uuid})$`, "i")

export function parseRuntimeRoute(url: string): Readonly<{ fileId: string; generationId: string; roomName: string }> | null {
  const parsed = new URL(url)
  const match = routePattern.exec(parsed.pathname)
  if (!match || !parsed.searchParams.get("clientId") || !parsed.searchParams.get("connectionNonce")) return null
  const fileId = match[1]!.toLowerCase()
  const generationId = match[2]!.toLowerCase()
  return Object.freeze({ fileId, generationId, roomName: `sync:2:${fileId}:${generationId}` })
}
