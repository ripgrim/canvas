import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { getApiRuntime } from './runtime.js'

const required = (name: string) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing ${name}.`)
  return value
}

const { app, pool } = getApiRuntime()
const port = Number(process.env.PORT ?? 4320)
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PORT is invalid.')

const server = createServer(async (incoming, outgoing) => {
  try {
    const request = await webRequest(incoming)
    const response = await app(request)
    outgoing.statusCode = response.status
    response.headers.forEach((value, name) => outgoing.setHeader(name, value))
    const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
    if (getSetCookie) {
      const cookies = getSetCookie.call(response.headers)
      if (cookies.length) outgoing.setHeader('set-cookie', cookies)
    }
    if (!response.body) { outgoing.end(); return }
    Readable.fromWeb(response.body as never).pipe(outgoing)
  } catch (error) {
    const requestId = randomUUID()
    const failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { name: 'UnknownError', message: String(error) }
    process.stderr.write(`${JSON.stringify({ level: 'error', event: 'api_transport_failed', requestId, method: incoming.method ?? 'GET', path: incoming.url ?? '/', error: failure })}\n`)
    outgoing.statusCode = 500
    outgoing.setHeader('Content-Type', 'application/json; charset=utf-8')
    outgoing.setHeader('X-Canvas-Request-Id', requestId)
    outgoing.end(JSON.stringify({ error: { code: 'internal_error', message: 'Request could not be completed.', requestId } }))
  }
})

server.listen(port, '127.0.0.1', () => process.stdout.write(`API: http://127.0.0.1:${port}/\n`))

async function webRequest(incoming: import('node:http').IncomingMessage): Promise<Request> {
  const host = incoming.headers.host ?? `127.0.0.1:${port}`
  const protocol = 'encrypted' in incoming.socket && incoming.socket.encrypted ? 'https' : 'http'
  const url = new URL(incoming.url ?? '/', `${protocol}://${host}`)
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item)
    else if (value !== undefined) headers.set(name, value)
  }
  const body = incoming.method === 'GET' || incoming.method === 'HEAD' ? undefined : await readBody(incoming, 6 * 1024 * 1024)
  return new Request(url, { method: incoming.method ?? 'GET', headers, ...(body ? { body: Uint8Array.from(body).buffer } : {}) })
}

async function readBody(incoming: import('node:http').IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of incoming) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > limit) throw new Error('Request body is too large.')
    chunks.push(bytes)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

const stop = () => server.close(() => void pool.end().finally(() => process.exit(0)))
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
