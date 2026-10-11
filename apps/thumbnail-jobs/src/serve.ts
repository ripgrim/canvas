import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { createHttpThumbnailQueuePort, createThumbnailJobService, createThumbnailQueueProcessor } from './index.js'

const required = (name: string): string => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

const triggerToken = required('THUMBNAIL_JOB_TRIGGER_TOKEN')
const service = createThumbnailJobService({
  apiOrigin: required('API_ORIGIN'),
  assetsOrigin: required('ASSETS_ORIGIN'),
  rendererOrigin: required('THUMBNAIL_RENDERER_ORIGIN'),
  serviceToken: required('THUMBNAIL_SERVICE_TOKEN'),
})
const queue = createThumbnailQueueProcessor({
  service,
  queue: createHttpThumbnailQueuePort({ apiOrigin: required('API_ORIGIN'), serviceToken: required('THUMBNAIL_SERVICE_TOKEN') }),
})
const port = Number(process.env.PORT ?? 4324)
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PORT is invalid.')

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') return send(response, 200, { ok: true })
  if (request.method !== 'POST' || request.url !== '/internal/thumbnail-jobs') return send(response, 404, { error: { code: 'not_found', message: 'Route not found.' } })
  if (!equalToken(request.headers['x-canvas-thumbnail-job-token'], triggerToken)) return send(response, 403, { error: { code: 'service_forbidden', message: 'Service access denied.' } })
  try {
    const body = await readJson(request)
    if (Object.keys(body).sort().join(',') !== 'expectedRevision,fileId' || typeof body.fileId !== 'string' || typeof body.expectedRevision !== 'number') throw new Error('invalid')
    const thumbnail = await service.run({ fileId: body.fileId, expectedRevision: body.expectedRevision })
    return send(response, 201, { thumbnail })
  } catch {
    return send(response, 409, { error: { code: 'thumbnail_failed', message: 'Thumbnail could not be generated.' } })
  }
})

let stopping = false
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Thumbnail jobs: http://127.0.0.1:${port}/\n`)
  void processQueue()
})
const stop = () => {
  stopping = true
  server.close(() => process.exit(0))
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

async function processQueue(): Promise<void> {
  while (!stopping) {
    try {
      const result = await queue.runOnce()
      await wait(result === 'idle' ? 1_000 : 0)
    } catch (error) {
      process.stderr.write(`Thumbnail job failed: ${error instanceof Error ? error.message : String(error)}\n`)
      await wait(2_000)
    }
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolveWait => setTimeout(resolveWait, milliseconds))
}

async function readJson(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > 16_384) throw new Error('large')
    chunks.push(bytes)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
  return value as Record<string, unknown>
}

function equalToken(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== 'string') return false
  const left = Buffer.from(value)
  const right = Buffer.from(expected)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

function send(response: import('node:http').ServerResponse, status: number, body: object): void {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.end(JSON.stringify(body))
}
