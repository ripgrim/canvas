import { collaborationWebSocketProtocol as syncWebSocketProtocol } from '@canvas/sync-protocol'

export { syncWebSocketProtocol }

export type ValidWebSocketHandshake = Readonly<{ protocol: typeof syncWebSocketProtocol }>

function connectionHasUpgrade(value: string | null): boolean {
  return value?.split(",").some(token => token.trim().toLowerCase() === "upgrade") ?? false
}

function validWebSocketKey(value: string | null): boolean {
  if (!value || !/^[A-Za-z0-9+/]{22}==$/.test(value)) return false
  try { return atob(value).length === 16 } catch { return false }
}

export function parseWebSocketProtocols(value: string | null): typeof syncWebSocketProtocol | null {
  if (value === null) return null
  const protocols = value.split(",")
  return protocols.length === 1 && protocols[0] === syncWebSocketProtocol ? syncWebSocketProtocol : null
}

export function validateWebSocketHandshake(request: Request): ValidWebSocketHandshake | null {
  const protocol = parseWebSocketProtocols(request.headers.get("Sec-WebSocket-Protocol"))
  if (request.method !== "GET"
    || request.headers.get("Upgrade")?.trim().toLowerCase() !== "websocket"
    || !connectionHasUpgrade(request.headers.get("Connection"))
    || request.headers.get("Sec-WebSocket-Version")?.trim() !== "13"
    || !validWebSocketKey(request.headers.get("Sec-WebSocket-Key"))
    || protocol === null) return null
  return Object.freeze({ protocol })
}
