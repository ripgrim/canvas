interface R2ObjectLike {
  body: ReadableStream
  size: number
  etag: string
  httpEtag: string
  writeHttpMetadata(headers: Headers): void
}

interface UpdateBucket {
  get(key: string, options?: Readonly<{ range?: { offset: number; length?: number } }>): Promise<R2ObjectLike | null>
}

interface Env { UPDATES: UpdateBucket }

const immutableArtifact = /^Comp Canvas(?: Nightly)? Setup \d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?\.exe(?:\.blockmap)?$/
const channelManifest = /^(?:latest|nightly)\.yml$/

export function updateObjectKey(pathname: string): string | null {
  const match = /^\/windows\/x64\/([^/]+)$/.exec(pathname)
  if (!match) return null
  const name = decodeURIComponent(match[1]!)
  if (name.includes('..') || (!channelManifest.test(name) && !immutableArtifact.test(name))) return null
  return `windows/x64/${name}`
}

function byteRange(header: string | null, size: number): { offset: number; length: number } | null | 'invalid' {
  if (!header) return null
  const match = /^bytes=(\d+)-(\d*)$/.exec(header)
  if (!match) return 'invalid'
  const offset = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(requestedEnd) || offset < 0 || requestedEnd < offset || offset >= size) return 'invalid'
  return { offset, length: Math.min(size - 1, requestedEnd) - offset + 1 }
}

export function createUpdateHandler(bucket: UpdateBucket) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
    const url = new URL(request.url)
    const key = updateObjectKey(url.pathname)
    if (!key) return new Response('Not found', { status: 404 })
    const metadata = await bucket.get(key)
    if (!metadata) return new Response('Not found', { status: 404 })
    const range = byteRange(request.headers.get('Range'), metadata.size)
    if (range === 'invalid') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${metadata.size}` } })
    const object = range ? await bucket.get(key, { range }) : metadata
    if (!object) return new Response('Not found', { status: 404 })
    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('Accept-Ranges', 'bytes')
    headers.set('ETag', object.httpEtag || object.etag)
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('Cache-Control', channelManifest.test(key.split('/').at(-1)!) ? 'no-store' : 'public, max-age=31536000, immutable')
    if (range) {
      headers.set('Content-Length', String(range.length))
      headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`)
    } else headers.set('Content-Length', String(metadata.size))
    return new Response(request.method === 'HEAD' ? null : object.body, { status: range ? 206 : 200, headers })
  }
}

export default { fetch(request: Request, env: Env) { return createUpdateHandler(env.UPDATES)(request) } }
