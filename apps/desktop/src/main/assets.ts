import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'

const mediaTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
}

export async function bundledAssetResponse(request: Request, root: string, csp: string): Promise<Response> {
  try {
    const url = new URL(request.url)
    if (request.method !== 'GET' || url.protocol !== 'design-editor:' || url.host !== 'app' || url.username || url.password || url.search) return new Response(null, { status: 403 })
    const path = decodeURIComponent(url.pathname)
    if (path.includes('\\') || path.includes('\0') || path.split('/').some((part) => part === '..' || part === '.')) return new Response(null, { status: 403 })
    const canonicalRoot = await realpath(root)
    // Client-side routes such as /file/<id> have no asset; serve the app shell so refresh and restart keep the route.
    const assetPath = path === '/' || !extname(path) ? '/index.html' : path
    const file = await realpath(resolve(canonicalRoot, `.${assetPath}`))
    const contained = relative(canonicalRoot, file)
    if (!contained || contained.startsWith('..') || isAbsolute(contained)) return new Response(null, { status: 403 })
    const mime = mediaTypes[extname(file)]
    if (!mime) return new Response(null, { status: 403 })
    return new Response(new Uint8Array(await readFile(file)), { headers: { 'Content-Type': mime, 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' } })
  } catch {
    return new Response(null, { status: 404 })
  }
}

export async function bundledScriptHashes(root: string): Promise<string[]> {
  const html = await readFile(resolve(root, 'index.html'), 'utf8')
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(match => !/\bsrc\s*=/i.test(match[1]!))
    .map(match => createHash('sha256').update(match[2]!).digest('base64'))
}