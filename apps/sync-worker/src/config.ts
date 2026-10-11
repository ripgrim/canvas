import type { ServiceFetcher } from "./platform.js"

export type SyncWorkerEnv = Readonly<{
  SYNC_COORDINATOR: ServiceFetcher
  API_ORIGIN: string
  COLLABORATION_ADMISSION_SERVICE_TOKEN: string
  COLLABORATION_BUILD_ID: string
  SYNC_COORDINATOR_INTERNAL_SECRET: string
  ALLOWED_ORIGINS: string
}>

export type WorkerConfiguration = Readonly<{
  apiOrigin: string
  allowedOrigins: ReadonlySet<string>
  buildId: string
  coordinatorSecret: Uint8Array
}>

const encoder = new TextEncoder()
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"])

function apiOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error("API_ORIGIN must be an absolute HTTP URL.") }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHosts.has(url.hostname)))
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("API_ORIGIN must use HTTPS, except for loopback development.")
  }
  return url.origin
}

function decodeSecret(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("SYNC_COORDINATOR_INTERNAL_SECRET must be base64url.")
  try {
    const source = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")
    return Uint8Array.from(atob(source), character => character.charCodeAt(0))
  } catch { throw new Error("SYNC_COORDINATOR_INTERNAL_SECRET must be base64url.") }
}

function browserOrigin(value: string, name: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`${name} must be an absolute HTTP URL.`) }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error(`${name} is invalid.`)
  return url.origin
}

export function parseAllowedOrigins(source: string): ReadonlySet<string> {
  const values = source.split(",").map(value => value.trim()).filter(Boolean)
  if (!values.length) throw new Error("ALLOWED_ORIGINS must contain at least one origin.")
  const origins = new Set(values.map((value, index) => browserOrigin(value, `ALLOWED_ORIGINS entry ${index + 1}`)))
  if (origins.size !== values.length) throw new Error("ALLOWED_ORIGINS must not contain duplicate origins.")
  return origins
}

export function validateWorkerEnv(env: SyncWorkerEnv): WorkerConfiguration {
  if (!env.SYNC_COORDINATOR || typeof env.SYNC_COORDINATOR.fetch !== "function") throw new Error("SYNC_COORDINATOR service binding is required.")
  if (encoder.encode(env.COLLABORATION_ADMISSION_SERVICE_TOKEN).byteLength < 32) throw new Error("COLLABORATION_ADMISSION_SERVICE_TOKEN must contain at least 32 bytes.")
  if (!identifier.test(env.COLLABORATION_BUILD_ID)) throw new Error("COLLABORATION_BUILD_ID is invalid.")
  const coordinatorSecret = decodeSecret(env.SYNC_COORDINATOR_INTERNAL_SECRET)
  if (coordinatorSecret.byteLength < 32) throw new Error("SYNC_COORDINATOR_INTERNAL_SECRET must decode to at least 32 bytes.")
  if (env.COLLABORATION_ADMISSION_SERVICE_TOKEN === env.SYNC_COORDINATOR_INTERNAL_SECRET) throw new Error("Sync service credentials must be independent.")
  return Object.freeze({ apiOrigin: apiOrigin(env.API_ORIGIN), allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS), buildId: env.COLLABORATION_BUILD_ID, coordinatorSecret })
}
