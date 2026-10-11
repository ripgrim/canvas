import type { DurableObjectNamespace } from "./platform.js"

export type SyncCoordinatorEnv = Readonly<{
  SYNC_ROOMS: DurableObjectNamespace
  SYNC_COORDINATOR_INTERNAL_SECRET: string
  SYNC_ROOM_TICKET_SECRET: string
  SYNC_ROOM_RUNTIME_ORIGIN: string
  SYNC_ROOM_TICKET_TTL_MS?: string
  ALLOWED_ORIGINS: string
}>

export type CoordinatorConfiguration = Readonly<{ coordinatorSecret: Uint8Array; ticketSecret: Uint8Array; runtimeOrigin: string; ticketTtlMs: number; allowedOrigins: ReadonlySet<string> }>
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"])

function secret(value: string, name: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${name} must be base64url.`)
  let bytes: Uint8Array
  try { bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), character => character.charCodeAt(0)) } catch { throw new Error(`${name} must be base64url.`) }
  if (bytes.byteLength < 32) throw new Error(`${name} must decode to at least 32 bytes.`)
  return bytes
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!
  return difference === 0
}

function origin(value: string, name: string, runtime = false): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`${name} must be an absolute HTTP URL.`) }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && (!runtime || loopbackHosts.has(url.hostname))))
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error(`${name} is invalid.`)
  return url.origin
}

export function validateCoordinatorEnv(env: SyncCoordinatorEnv): CoordinatorConfiguration {
  if (!env.SYNC_ROOMS || typeof env.SYNC_ROOMS.idFromName !== "function" || typeof env.SYNC_ROOMS.get !== "function") throw new Error("SYNC_ROOMS is required.")
  const ticketTtlMs = Number(env.SYNC_ROOM_TICKET_TTL_MS ?? 300_000)
  if (!Number.isSafeInteger(ticketTtlMs) || ticketTtlMs < 10_000 || ticketTtlMs > 900_000) throw new Error("SYNC_ROOM_TICKET_TTL_MS is invalid.")
  const origins = env.ALLOWED_ORIGINS.split(",").map((value, index) => origin(value.trim(), `ALLOWED_ORIGINS entry ${index + 1}`)).filter(Boolean)
  if (!origins.length || new Set(origins).size !== origins.length) throw new Error("ALLOWED_ORIGINS is invalid.")
  const coordinatorSecret = secret(env.SYNC_COORDINATOR_INTERNAL_SECRET, "SYNC_COORDINATOR_INTERNAL_SECRET")
  const ticketSecret = secret(env.SYNC_ROOM_TICKET_SECRET, "SYNC_ROOM_TICKET_SECRET")
  if (equal(coordinatorSecret, ticketSecret)) throw new Error("Sync service credentials must be independent.")
  return Object.freeze({ coordinatorSecret, ticketSecret, runtimeOrigin: origin(env.SYNC_ROOM_RUNTIME_ORIGIN, "SYNC_ROOM_RUNTIME_ORIGIN", true), ticketTtlMs, allowedOrigins: new Set(origins) })
}
