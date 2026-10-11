export const syncWebSocketProtocol = "canvas-sync-v2"
export type ValidWebSocketHandshake = Readonly<{ protocol: typeof syncWebSocketProtocol }>

function validKey(value: string | null): boolean {
  if (!value || !/^[A-Za-z0-9+/]{22}==$/.test(value)) return false
  try { return atob(value).length === 16 } catch { return false }
}

export function validateWebSocketHandshake(request: Request): ValidWebSocketHandshake | null {
  const connection = request.headers.get("Connection")?.split(",").some(token => token.trim().toLowerCase() === "upgrade") ?? false
  const offered = request.headers.get("Sec-WebSocket-Protocol")
  const protocols = offered === null ? [] : offered.split(",").map(value => value.trim()).filter(Boolean)
  const protocol = protocols.length === 1 && protocols[0] === syncWebSocketProtocol ? syncWebSocketProtocol : false
  if (request.method !== "GET" || request.headers.get("Upgrade")?.trim().toLowerCase() !== "websocket" || !connection
    || request.headers.get("Sec-WebSocket-Version")?.trim() !== "13" || !validKey(request.headers.get("Sec-WebSocket-Key")) || protocol === false) return null
  return Object.freeze({ protocol })
}
