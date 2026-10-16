import { verifyHostedPreviewCapability } from "@canvas/preview-runtime/hosted-capability"

export type HostedPreviewGatewayOptions = Readonly<{
  previewOrigin: string
  assetsOrigin: string
  editorOrigins: readonly string[]
  serviceToken: string
  capabilitySecret: string
  fetch?: typeof globalThis.fetch
  now?: () => number
  requestId?: () => string
}>

const contentTypes = new Set([
  "text/html; charset=utf-8",
  "text/javascript; charset=utf-8",
  "text/css; charset=utf-8",
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/webp",
  "font/woff2",
])

class HostedPreviewUpstreamError extends Error {
  override readonly name = "HostedPreviewUpstreamError"
}

export function createHostedPreviewGateway(options: HostedPreviewGatewayOptions): (request: Request) => Promise<Response> {
  const previewOrigin = origin(options.previewOrigin)
  const assetsOrigin = origin(options.assetsOrigin)
  const editorOrigins = Object.freeze([...new Set(options.editorOrigins.map(editorFrameSource))])
  if (!editorOrigins.length || previewOrigin === assetsOrigin || editorOrigins.includes(previewOrigin)) throw new Error("Hosted preview origins are invalid.")
  if (new TextEncoder().encode(options.serviceToken).byteLength < 32 || /[\r\n]/.test(options.serviceToken)) throw new Error("Hosted preview service token is invalid.")
  if (new TextEncoder().encode(options.capabilitySecret).byteLength < 32 || /[\r\n]/.test(options.capabilitySecret)) throw new Error("Hosted preview capability secret is invalid.")
  const requestFetch = options.fetch ?? globalThis.fetch
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const requestId = options.requestId ?? (() => globalThis.crypto.randomUUID())
  const contentSecurityPolicy = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "worker-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${editorOrigins.join(" ")}`,
  ].join("; ")

  return async request => {
    const id = requestId()
    try {
      const url = new URL(request.url)
      if (url.origin !== previewOrigin || url.search || url.hash) return failure(404, id)
      const route = parseRoute(url.pathname)
      if (!route) return failure(404, id)
      if (request.method !== "GET" && request.method !== "HEAD") return failure(405, id, { Allow: "GET, HEAD" })
      await verifyHostedPreviewCapability({
        token: route.token,
        artifactId: route.artifactId,
        audience: previewOrigin,
        secret: options.capabilitySecret,
        now: now(),
      })
      const internalUrl = new URL(`/internal/hosted-previews/${route.artifactId}/files/${route.path}`, assetsOrigin)
      let upstream: Response
      try {
        upstream = await requestFetch(internalUrl, {
          method: request.method,
          headers: {
            "X-Canvas-Request-Id": id,
            "X-Canvas-Service-Token": options.serviceToken,
          },
          redirect: "manual",
        })
      } catch (error) {
        throw new HostedPreviewUpstreamError("Hosted preview asset request failed.", { cause: error })
      }
      if (upstream.status === 404) return failure(404, id)
      if (!upstream.ok || upstream.redirected || upstream.status < 200 || upstream.status >= 300) throw new HostedPreviewUpstreamError("Hosted preview asset request failed.")
      const headers = verifiedUpstreamHeaders(upstream.headers, route.artifactId)
      headers.set("Content-Security-Policy", contentSecurityPolicy)
      headers.set("Cross-Origin-Opener-Policy", "same-origin")
      headers.set("Cross-Origin-Resource-Policy", "same-origin")
      headers.set("Permissions-Policy", "camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()")
      headers.set("Referrer-Policy", "no-referrer")
      headers.set("X-Canvas-Request-Id", id)
      headers.set("X-Content-Type-Options", "nosniff")
      return new Response(request.method === "HEAD" ? null : upstream.body, { status: 200, headers })
    } catch (error) {
      const failureId = id
      console.error(JSON.stringify({
        level: "error",
        event: "hosted_preview_gateway_failed",
        requestId: failureId,
        method: request.method,
        pathname: redactedPath(new URL(request.url).pathname),
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { name: "UnknownError", message: String(error) },
      }))
      return failure(error instanceof HostedPreviewUpstreamError ? 502 : 404, failureId)
    }
  }
}

function redactedPath(pathname: string): string {
  const match = /^(\/hosted\/[0-9a-f-]{36}\/)[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(\/.*)$/i.exec(pathname)
  return match?.[1] && match[2] ? `${match[1]}[capability]${match[2]}` : "/hosted/[invalid]"
}

function parseRoute(pathname: string): Readonly<{ artifactId: string; token: string; path: string }> | null {
  const match = /^\/hosted\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\/([A-Za-z0-9][A-Za-z0-9._/-]*)$/i.exec(pathname)
  if (!match?.[1] || !match[2] || !match[3] || match[3].endsWith("/") || match[3].split("/").some(part => !part || part === "." || part === "..")) return null
  return Object.freeze({ artifactId: match[1].toLowerCase(), token: match[2], path: match[3] })
}

function verifiedUpstreamHeaders(input: Headers, artifactId: string): Headers {
  const contentType = input.get("content-type")
  const contentLength = input.get("content-length")
  const digest = input.get("x-canvas-artifact-sha256")
  const upstreamArtifactId = input.get("x-canvas-artifact-id")
  if (
    !contentType || !contentTypes.has(contentType) ||
    !contentLength || !/^(0|[1-9][0-9]{0,7})$/.test(contentLength) || Number(contentLength) > 8 * 1024 * 1024 ||
    !digest || !/^[a-f0-9]{64}$/.test(digest) ||
    upstreamArtifactId?.toLowerCase() !== artifactId ||
    input.get("etag") !== `"${digest}"`
  ) throw new HostedPreviewUpstreamError("Hosted preview asset response is invalid.")
  return new Headers({
    "Cache-Control": "private, no-store",
    "Content-Length": contentLength,
    "Content-Type": contentType,
    ETag: `"${digest}"`,
  })
}

function failure(status: 404 | 405 | 502, requestId: string, additional?: HeadersInit): Response {
  return new Response(status === 405 ? "Method not allowed" : status === 502 ? "Preview unavailable" : "Not found", {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Canvas-Request-Id": requestId,
      "X-Content-Type-Options": "nosniff",
      ...additional,
    },
  })
}

function origin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error("Hosted preview origin is invalid.") }
  if (url.origin !== value || url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw new Error("Hosted preview origin is invalid.")
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Hosted preview origin is invalid.")
  return url.origin
}

function editorFrameSource(value: string): string {
  if (value === "design-editor://app") return value
  return origin(value)
}
