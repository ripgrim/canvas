import type { DurableObjectContext, DurableObjectNamespace, ExecutionContext } from './platform.js'

const containerPort = 4324
const queueContainerName = 'thumbnail-queue'
const readinessAttempts = 60
const readinessDelayMs = 500
const inactivityMs = 120_000

export type ThumbnailWorkerEnv = Readonly<{
  THUMBNAIL_CONTAINERS: DurableObjectNamespace
  API_ORIGIN: string
  ASSETS_ORIGIN: string
  THUMBNAIL_RENDERER_ORIGIN: string
  THUMBNAIL_SERVICE_TOKEN: string
  THUMBNAIL_JOB_TRIGGER_TOKEN: string
}>

const wait = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds))

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim()
  if (!normalized) throw new Error(`${name} is required.`)
  return normalized
}

function serviceOrigin(value: string | undefined, name: string): string {
  const source = required(value, name)
  let url: URL
  try { url = new URL(source) } catch { throw new Error(`${name} must be an HTTPS origin.`) }
  if (url.protocol !== 'https:' || url.origin !== source || url.username || url.password) throw new Error(`${name} must be an HTTPS origin.`)
  return url.origin
}

function secret(value: string | undefined, name: string): string {
  const source = required(value, name)
  if (new TextEncoder().encode(source).byteLength < 32 || /[\r\n]/.test(source)) throw new Error(`${name} is invalid.`)
  return source
}

function configuration(env: ThumbnailWorkerEnv) {
  if (!env.THUMBNAIL_CONTAINERS || typeof env.THUMBNAIL_CONTAINERS.idFromName !== 'function' || typeof env.THUMBNAIL_CONTAINERS.get !== 'function') throw new Error('THUMBNAIL_CONTAINERS is required.')
  return Object.freeze({
    apiOrigin: serviceOrigin(env.API_ORIGIN, 'API_ORIGIN'),
    assetsOrigin: serviceOrigin(env.ASSETS_ORIGIN, 'ASSETS_ORIGIN'),
    rendererOrigin: serviceOrigin(env.THUMBNAIL_RENDERER_ORIGIN, 'THUMBNAIL_RENDERER_ORIGIN'),
    serviceToken: secret(env.THUMBNAIL_SERVICE_TOKEN, 'THUMBNAIL_SERVICE_TOKEN'),
    triggerToken: secret(env.THUMBNAIL_JOB_TRIGGER_TOKEN, 'THUMBNAIL_JOB_TRIGGER_TOKEN'),
  })
}

export class ThumbnailJobContainer {
  readonly #context: DurableObjectContext
  readonly #configuration: ReturnType<typeof configuration>
  #starting: Promise<void> | undefined

  constructor(context: DurableObjectContext, env: ThumbnailWorkerEnv) {
    if (!context.container) throw new Error('Thumbnail container binding is unavailable.')
    this.#context = context
    this.#configuration = configuration(env)
    if (context.container.running) void context.blockConcurrencyWhile(() => context.container!.setInactivityTimeout(inactivityMs))
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'GET' || url.pathname !== '/healthz' || url.search) return new Response(null, { status: 404 })
    this.#starting ??= this.#start().finally(() => { this.#starting = undefined })
    await this.#starting
    return this.#context.container!.getTcpPort(containerPort).fetch('http://container/healthz', { signal: AbortSignal.timeout(2_000) })
  }

  async #start(): Promise<void> {
    const container = this.#context.container!
    if (!container.running) {
      container.start({ env: {
        API_ORIGIN: this.#configuration.apiOrigin,
        ASSETS_ORIGIN: this.#configuration.assetsOrigin,
        THUMBNAIL_RENDERER_ORIGIN: this.#configuration.rendererOrigin,
        THUMBNAIL_SERVICE_TOKEN: this.#configuration.serviceToken,
        THUMBNAIL_JOB_TRIGGER_TOKEN: this.#configuration.triggerToken,
        HOST: '0.0.0.0',
        PORT: String(containerPort),
        NODE_ENV: 'production',
      } })
    }
    await container.setInactivityTimeout(inactivityMs)
    const runtime = container.getTcpPort(containerPort)
    let lastError: unknown
    for (let attempt = 0; attempt < readinessAttempts; attempt += 1) {
      try {
        const response = await runtime.fetch('http://container/healthz', { signal: AbortSignal.timeout(1_000) })
        await response.body?.cancel()
        if (!response.ok) throw new Error(`Thumbnail container health check returned ${response.status}.`)
        return
      } catch (error) {
        lastError = error
        await wait(readinessDelayMs)
      }
    }
    throw new Error('Thumbnail container did not become ready.', { cause: lastError })
  }
}

async function wakeQueue(env: ThumbnailWorkerEnv): Promise<void> {
  configuration(env)
  const response = await env.THUMBNAIL_CONTAINERS
    .get(env.THUMBNAIL_CONTAINERS.idFromName(queueContainerName))
    .fetch('https://thumbnail.internal/healthz')
  await response.body?.cancel()
  if (!response.ok) throw new Error(`Thumbnail queue wake returned ${response.status}.`)
}

export default {
  fetch(): Response {
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } }), {
      status: 404,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
    })
  },
  scheduled(_controller: unknown, env: ThumbnailWorkerEnv, context: ExecutionContext): void {
    context.waitUntil(wakeQueue(env))
  },
}

export { configuration as validateThumbnailWorkerEnv, wakeQueue }
