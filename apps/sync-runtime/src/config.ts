import type { DurableObjectNamespace } from "./platform.js"

export type SyncRuntimeEnv = Readonly<{
  ROOM_CONTAINERS: DurableObjectNamespace
  DATABASE_URL: string
  SYNC_ROOM_TICKET_SECRET: string
  ALLOWED_ORIGINS: string
  SYNC_CONTAINER_INACTIVITY_MS?: string
}>

export type RuntimeConfiguration = Readonly<{
  databaseUrl: string
  ticketSecret: string
  allowedOrigins: string
  inactivityMs: number
}>

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim()
  if (!normalized) throw new Error(`${name} is required.`)
  return normalized
}

export function validateRuntimeEnv(env: SyncRuntimeEnv): RuntimeConfiguration {
  if (!env.ROOM_CONTAINERS || typeof env.ROOM_CONTAINERS.idFromName !== "function" || typeof env.ROOM_CONTAINERS.get !== "function") throw new Error("ROOM_CONTAINERS is required.")
  const databaseUrl = required(env.DATABASE_URL, "DATABASE_URL")
  let database: URL
  try { database = new URL(databaseUrl) } catch { throw new Error("DATABASE_URL must be a PostgreSQL URL.") }
  if (!new Set(["postgres:", "postgresql:"]).has(database.protocol) || !database.hostname || !database.pathname.slice(1)) throw new Error("DATABASE_URL must be a PostgreSQL URL.")
  const ticketSecret = required(env.SYNC_ROOM_TICKET_SECRET, "SYNC_ROOM_TICKET_SECRET")
  if (!/^[A-Za-z0-9_-]+$/.test(ticketSecret) || Uint8Array.from(atob(ticketSecret.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(ticketSecret.length / 4) * 4, "=")), character => character.charCodeAt(0)).byteLength < 32) throw new Error("SYNC_ROOM_TICKET_SECRET must decode to at least 32 bytes.")
  const origins = required(env.ALLOWED_ORIGINS, "ALLOWED_ORIGINS").split(",").map(value => new URL(value.trim()).origin)
  if (!origins.length || new Set(origins).size !== origins.length || origins.some(origin => !origin.startsWith("https://"))) throw new Error("ALLOWED_ORIGINS is invalid.")
  const inactivityMs = Number(env.SYNC_CONTAINER_INACTIVITY_MS ?? 600_000)
  if (!Number.isSafeInteger(inactivityMs) || inactivityMs < 60_000 || inactivityMs > 21_600_000) throw new Error("SYNC_CONTAINER_INACTIVITY_MS is invalid.")
  return Object.freeze({ databaseUrl, ticketSecret, allowedOrigins: origins.join(","), inactivityMs })
}
