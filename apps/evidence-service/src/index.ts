interface EvidenceObject {
  body: ReadableStream
  size: number
  etag: string
  httpEtag: string
}

interface EvidenceBucket {
  get(key: string, options?: Readonly<{ range?: { offset: number; length: number } }>): Promise<EvidenceObject | null>
  head(key: string): Promise<EvidenceObject | null>
}

interface Env {
  EVIDENCE: EvidenceBucket
}

export function evidenceObject(pathname: string): Readonly<{ key: string; type: string }> | null {
  const match = /^\/([1-9]\d*)\/([a-f0-9]{64})\.(png|webm)$/u.exec(pathname)
  if (!match) return null
  return Object.freeze({ key: `${match[1]}/${match[2]}.${match[3]}`, type: match[3] === "png" ? "image/png" : "video/webm" })
}

export function createEvidenceHandler(env: Env) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } })
    const target = evidenceObject(new URL(request.url).pathname)
    if (!target) return new Response("Not found", { status: 404 })
    const metadata = await env.EVIDENCE.head(target.key)
    if (!metadata) return new Response("Not found", { status: 404 })
    const range = byteRange(request.headers.get("Range"), metadata.size)
    if (range === "invalid") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${metadata.size}` } })
    const object = request.method === "HEAD" ? metadata : await env.EVIDENCE.get(target.key, range ? { range } : undefined)
    if (!object) return new Response("Not found", { status: 404 })
    const headers = new Headers({
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Length": String(range?.length ?? metadata.size),
      "Content-Type": target.type,
      "Cross-Origin-Resource-Policy": "cross-origin",
      "ETag": object.httpEtag || object.etag,
      "X-Content-Type-Options": "nosniff",
    })
    if (range) headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`)
    return new Response(request.method === "HEAD" ? null : object.body, { status: range ? 206 : 200, headers })
  }
}

function byteRange(value: string | null, size: number): Readonly<{ offset: number; length: number }> | null | "invalid" {
  if (!value) return null
  const match = /^bytes=(\d+)-(\d*)$/u.exec(value)
  if (!match) return "invalid"
  const offset = Number(match[1])
  const end = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 0 || end < offset || offset >= size) return "invalid"
  return Object.freeze({ offset, length: Math.min(end, size - 1) - offset + 1 })
}

export default { fetch(request: Request, env: Env) { return createEvidenceHandler(env)(request) } }
