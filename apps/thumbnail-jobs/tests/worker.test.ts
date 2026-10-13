import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import worker, { ThumbnailJobContainer, validateThumbnailWorkerEnv, wakeQueue, type ThumbnailWorkerEnv } from '../src/worker.js'

const serviceToken = 's'.repeat(32)
const triggerToken = 't'.repeat(32)

function environment(fetcher = vi.fn<(request: Request | string) => Promise<Response>>(async () => new Response(null, { status: 200 }))): ThumbnailWorkerEnv {
  return {
    API_ORIGIN: 'https://api-staging.canvas.example',
    ASSETS_ORIGIN: 'https://assets-staging.canvas.example',
    THUMBNAIL_RENDERER_ORIGIN: 'https://thumbnails-staging.canvas.example',
    THUMBNAIL_SERVICE_TOKEN: serviceToken,
    THUMBNAIL_JOB_TRIGGER_TOKEN: triggerToken,
    THUMBNAIL_CONTAINERS: { idFromName: name => name, get: () => ({ fetch: fetcher }) },
  }
}

describe('hosted thumbnail queue', () => {
  it('AT-THUMB-001 wakes one stable private queue container from the scheduler', async () => {
    const fetcher = vi.fn<(request: Request | string) => Promise<Response>>(async () => new Response(null, { status: 200 }))
    const env = environment(fetcher)
    const pending: Promise<unknown>[] = []
    worker.scheduled({}, env, { waitUntil: promise => pending.push(promise) })
    await Promise.all(pending)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]![0]).toBe('https://thumbnail.internal/healthz')
    expect((await worker.fetch()).status).toBe(404)
  })

  it('AT-THUMB-001 starts Playwright with only bounded service configuration', async () => {
    const requests: Array<Request | string> = []
    const start = vi.fn()
    const fetcher = vi.fn(async (request: Request | string) => {
      requests.push(request)
      return new Response(null, { status: 200 })
    })
    const env = environment()
    const context = {
      container: { running: false, start, setInactivityTimeout: vi.fn(async () => undefined), getTcpPort: () => ({ fetch: fetcher }) },
      blockConcurrencyWhile: async <T>(callback: () => Promise<T>) => callback(),
    }
    expect((await new ThumbnailJobContainer(context, env).fetch(new Request('https://thumbnail.internal/healthz'))).status).toBe(200)
    expect(start).toHaveBeenCalledOnce()
    expect(start.mock.calls[0]![0]!.env).toEqual({
      API_ORIGIN: env.API_ORIGIN,
      ASSETS_ORIGIN: env.ASSETS_ORIGIN,
      THUMBNAIL_RENDERER_ORIGIN: env.THUMBNAIL_RENDERER_ORIGIN,
      THUMBNAIL_SERVICE_TOKEN: serviceToken,
      THUMBNAIL_JOB_TRIGGER_TOKEN: triggerToken,
      HOST: '0.0.0.0',
      PORT: '4324',
      NODE_ENV: 'production',
    })
    expect(requests).toEqual(['http://container/healthz', 'http://container/healthz'])
  })

  it('AT-THUMB-001 fails closed on missing secrets and non-HTTPS hosted origins', async () => {
    const env = environment()
    expect(() => validateThumbnailWorkerEnv({ ...env, THUMBNAIL_SERVICE_TOKEN: '' })).toThrow('THUMBNAIL_SERVICE_TOKEN')
    expect(() => validateThumbnailWorkerEnv({ ...env, API_ORIGIN: 'http://api-staging.canvas.example' })).toThrow('API_ORIGIN')
    await expect(wakeQueue({ ...env, THUMBNAIL_JOB_TRIGGER_TOKEN: 'short' })).rejects.toThrow('THUMBNAIL_JOB_TRIGGER_TOKEN')
  })

  it('AT-THUMB-001 declares a scheduled single-container Playwright deployment', () => {
    const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
    expect(config).toContain('"crons": ["* * * * *"]')
    expect(config).toContain('"max_instances": 1')
    expect(config).toContain('"workers_dev": false')
    expect(dockerfile).toContain('mcr.microsoft.com/playwright:v1.63.0-noble')
    expect(dockerfile).toContain('CMD ["node", "dist/serve.js"]')
  })
})
