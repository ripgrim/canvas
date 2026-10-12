import { chromium, type Page } from '@playwright/test'
import sharp from 'sharp'
import {
  createHttpThumbnailUploadPort,
  createThumbnailCapturePipeline,
  type ThumbnailCapturePort,
  type ThumbnailCaptureRequest,
  type ThumbnailMetadata,
  type ThumbnailMetadataPort,
} from '@canvas/thumbnail-capture'

export type ThumbnailSource = Readonly<{
  fileId: string
  revision: number
  pageId: string
  document: unknown
  registryFingerprint: string
}>

export interface ThumbnailSourcePort {
  read(fileId: string, expectedRevision: number): Promise<ThumbnailSource>
}

export type ThumbnailJob = Readonly<{ fileId: string; expectedRevision: number }>

export type ThumbnailQueueJob = Readonly<{
  id: string
  fileId: string
  revision: number
  leaseId: string
  leaseExpiresAt: string
  attempts: number
}>

export interface ThumbnailQueuePort {
  claim(): Promise<ThumbnailQueueJob | null>
  complete(jobId: string, leaseId: string): Promise<void>
  release(jobId: string, leaseId: string): Promise<void>
}

export type ThumbnailJobService = Readonly<{
  run(job: ThumbnailJob): Promise<ThumbnailMetadata>
}>

export type ThumbnailQueueProcessor = Readonly<{
  runOnce(): Promise<'idle' | 'completed' | 'released'>
}>

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function createHttpThumbnailSourcePort(options: Readonly<{
  apiOrigin: string
  serviceToken: string
  fetch?: typeof globalThis.fetch
  path?: string
}>): ThumbnailSourcePort {
  const origin = serviceOrigin(options.apiOrigin, 'API origin')
  const serviceToken = secret(options.serviceToken, 'Thumbnail service token')
  const fetchRequest = options.fetch ?? globalThis.fetch
  const path = options.path ?? '/internal/thumbnail-source'
  return Object.freeze({
    async read(fileId: string, expectedRevision: number) {
      const id = identifier(fileId, 'file id')
      const revision = expectedRevisionValue(expectedRevision)
      const response = await fetchRequest(new URL(path, origin), {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json', 'X-Canvas-Thumbnail-Service-Token': serviceToken },
        body: JSON.stringify({ fileId: id, expectedRevision: revision }),
      })
      await checked(response, 'Thumbnail source')
      const record = exactRecord(await response.json(), ['document', 'fileId', 'pageId', 'registryFingerprint', 'revision'], 'thumbnail source')
      if (record.fileId !== id || record.revision !== revision || typeof record.pageId !== 'string' || !identifierPattern.test(record.pageId) || typeof record.registryFingerprint !== 'string' || !/^sha256-[A-Za-z0-9+/]{43}=$/.test(record.registryFingerprint)) {
        throw new Error('Thumbnail source identity does not match the request.')
      }
      return Object.freeze({ fileId: id, revision, pageId: record.pageId, registryFingerprint: record.registryFingerprint, document: structuredClone(record.document) })
    },
  })
}

export function createPlaywrightThumbnailCapturePort(options: Readonly<{
  rendererOrigin: string
  source: ThumbnailSourcePort
}>): ThumbnailCapturePort {
  const rendererOrigin = serviceOrigin(options.rendererOrigin, 'Thumbnail renderer origin')
  const rendererUrl = new URL('/thumbnail-renderer', rendererOrigin)
  return Object.freeze({
    async capture(request: ThumbnailCaptureRequest) {
      const source = await options.source.read(request.fileId, request.expectedRevision)
      const browser = await chromium.launch({ headless: true })
      try {
        const context = await browser.newContext({
          viewport: { width: request.maxWidth, height: request.maxHeight },
          deviceScaleFactor: 1,
          colorScheme: 'light',
          reducedMotion: 'reduce',
          serviceWorkers: 'block',
        })
        const page = await context.newPage()
        const rendererErrors: string[] = []
        page.on('pageerror', error => rendererErrors.push(error.message))
        page.on('console', message => { if (message.type() === 'error') rendererErrors.push(message.text()) })
        page.on('requestfailed', failed => rendererErrors.push(`${failed.url()}: ${failed.failure()?.errorText ?? 'request failed'}`))
        await page.addInitScript(value => { window.__CANVAS_THUMBNAIL_SOURCE__ = value }, { fileId: source.fileId, revision: source.revision, pageId: source.pageId, registryFingerprint: source.registryFingerprint, file: source.document })
        const response = await page.goto(rendererUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 10_000 })
        if (!response?.ok() || new URL(page.url()).origin !== rendererOrigin || new URL(page.url()).pathname !== rendererUrl.pathname) {
          throw new Error('Thumbnail renderer navigation failed.')
        }
        try {
          await page.waitForFunction(
            identity => window.__PAPER_THUMBNAIL_READY === true && document.documentElement.dataset.paperThumbnailFileId === identity,
            request.fileId,
            { timeout: 13_000 },
          )
        } catch (error) {
          const state = await page.evaluate(() => ({
            phase: document.documentElement.dataset.paperThumbnailPhase,
            error: document.documentElement.dataset.paperThumbnailError,
          }))
          const detail = state.error ?? (rendererErrors.length > 0 ? rendererErrors.join(' | ') : 'no renderer error')
          throw new Error(`Thumbnail renderer did not become ready (${state.phase ?? 'unknown'}): ${detail}`, { cause: error })
        }
        const state = await page.evaluate(() => ({
          phase: document.documentElement.dataset.paperThumbnailPhase,
          error: document.documentElement.dataset.paperThumbnailError,
        }))
        if (state.phase !== 'ready' || state.error) throw new Error('Thumbnail renderer did not become ready.')
        await waitForThumbnailResources(page)
        const png = await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' })
        const avif = await sharp(png).avif({ quality: 60, effort: 4 }).toBuffer()
        return new Uint8Array(avif)
      } finally {
        await browser.close()
      }
    },
  })
}

export async function waitForThumbnailResources(page: Page, timeoutMs = 5_000): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid thumbnail resource timeout.')
  await page.evaluate(async timeout => {
    let timer = 0
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timer = window.setTimeout(() => reject(new Error('Thumbnail resources timed out.')), timeout)
    })
    const resources = (async () => {
      await document.fonts.ready
      await Promise.all([...document.images].map(async image => {
        try { await image.decode() } catch { throw new Error('Thumbnail image could not be decoded.') }
        if (!image.complete || image.naturalWidth < 1 || image.naturalHeight < 1) throw new Error('Thumbnail image could not be decoded.')
      }))
    })()
    try { await Promise.race([resources, timeoutFailure]) } finally { window.clearTimeout(timer) }
  }, timeoutMs)
}

export function createHttpThumbnailMetadataPort(options: Readonly<{
  apiOrigin: string
  serviceToken: string
  fetch?: typeof globalThis.fetch
  path?: string
}>): ThumbnailMetadataPort {
  const origin = serviceOrigin(options.apiOrigin, 'API origin')
  const serviceToken = secret(options.serviceToken, 'Thumbnail service token')
  const fetchRequest = options.fetch ?? globalThis.fetch
  const path = options.path ?? '/internal/thumbnail-metadata'
  return Object.freeze({
    async commit(input: Parameters<ThumbnailMetadataPort['commit']>[0]) {
      const response = await fetchRequest(new URL(path, origin), {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json', 'X-Canvas-Thumbnail-Service-Token': serviceToken },
        body: JSON.stringify(input),
      })
      await checked(response, 'Thumbnail metadata')
      const body = exactRecord(await response.json(), ['thumbnail'], 'thumbnail metadata response')
      const thumbnail = exactRecord(body.thumbnail, ['fileId', 'revision', 'thumbnailEtag', 'thumbnailKey'], 'thumbnail metadata')
      if (
        thumbnail.fileId !== input.fileId ||
        thumbnail.revision !== input.expectedRevision ||
        thumbnail.thumbnailKey !== input.thumbnailKey ||
        thumbnail.thumbnailEtag !== input.thumbnailEtag
      ) throw new Error('Thumbnail metadata response does not match the request.')
      return Object.freeze({
        fileId: input.fileId,
        revision: input.expectedRevision,
        thumbnailKey: input.thumbnailKey,
        thumbnailEtag: input.thumbnailEtag,
      })
    },
  })
}

export function createHttpThumbnailQueuePort(options: Readonly<{
  apiOrigin: string
  serviceToken: string
  fetch?: typeof globalThis.fetch
}>): ThumbnailQueuePort {
  const origin = serviceOrigin(options.apiOrigin, 'API origin')
  const serviceToken = secret(options.serviceToken, 'Thumbnail service token')
  const fetchRequest = options.fetch ?? globalThis.fetch
  const request = async (path: string, body: object): Promise<Record<string, unknown>> => {
    const response = await fetchRequest(new URL(path, origin), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', 'X-Canvas-Thumbnail-Service-Token': serviceToken },
      body: JSON.stringify(body),
    })
    await checked(response, 'Thumbnail queue')
    return exactRecord(await response.json(), path.endsWith('/claim') ? ['job'] : ['status'], 'thumbnail queue response')
  }
  return Object.freeze({
    async claim() {
      const body = await request('/internal/thumbnail-jobs/claim', {})
      if (body.job === null) return null
      const job = exactRecord(body.job, ['attempts', 'fileId', 'id', 'leaseExpiresAt', 'leaseId', 'revision'], 'thumbnail queue job')
      if (
        typeof job.id !== 'string' || !identifierPattern.test(job.id) ||
        typeof job.fileId !== 'string' || !identifierPattern.test(job.fileId) ||
        typeof job.leaseId !== 'string' || !identifierPattern.test(job.leaseId) ||
        typeof job.leaseExpiresAt !== 'string' || !Number.isFinite(Date.parse(job.leaseExpiresAt)) ||
        typeof job.revision !== 'number' || expectedRevisionValue(job.revision) !== job.revision ||
        typeof job.attempts !== 'number' || !Number.isSafeInteger(job.attempts) || job.attempts < 1
      ) throw new Error('Invalid thumbnail queue job.')
      return Object.freeze({
        id: job.id,
        fileId: job.fileId,
        revision: job.revision,
        leaseId: job.leaseId,
        leaseExpiresAt: job.leaseExpiresAt,
        attempts: job.attempts,
      })
    },
    async complete(jobId: string, leaseId: string) {
      const body = await request(`/internal/thumbnail-jobs/${identifier(jobId, 'job id')}/complete`, { leaseId: identifier(leaseId, 'lease id') })
      if (body.status !== 'completed') throw new Error('Thumbnail queue completion was not confirmed.')
    },
    async release(jobId: string, leaseId: string) {
      const body = await request(`/internal/thumbnail-jobs/${identifier(jobId, 'job id')}/release`, { leaseId: identifier(leaseId, 'lease id') })
      if (body.status !== 'released') throw new Error('Thumbnail queue release was not confirmed.')
    },
  })
}

export function createThumbnailQueueProcessor(options: Readonly<{
  queue: ThumbnailQueuePort
  service: ThumbnailJobService
}>): ThumbnailQueueProcessor {
  return Object.freeze({
    async runOnce() {
      const job = await options.queue.claim()
      if (!job) return 'idle'
      try {
        await options.service.run({ fileId: job.fileId, expectedRevision: job.revision })
        await options.queue.complete(job.id, job.leaseId)
        return 'completed'
      } catch (error) {
        await options.queue.release(job.id, job.leaseId)
        throw error
      }
    },
  })
}

export function createThumbnailJobService(options: Readonly<{
  apiOrigin: string
  assetsOrigin: string
  rendererOrigin: string
  serviceToken: string
  fetch?: typeof globalThis.fetch
}>): ThumbnailJobService {
  const source = createHttpThumbnailSourcePort({ apiOrigin: options.apiOrigin, serviceToken: options.serviceToken, ...(options.fetch ? { fetch: options.fetch } : {}) })
  const pipeline = createThumbnailCapturePipeline({
    capture: createPlaywrightThumbnailCapturePort({ rendererOrigin: options.rendererOrigin, source }),
    upload: createHttpThumbnailUploadPort({
      assetsOrigin: options.assetsOrigin,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      headers: () => ({ 'X-Canvas-Thumbnail-Service-Token': options.serviceToken }),
    }),
    metadata: createHttpThumbnailMetadataPort({ apiOrigin: options.apiOrigin, serviceToken: options.serviceToken, ...(options.fetch ? { fetch: options.fetch } : {}) }),
  })
  return Object.freeze({
    run(job: ThumbnailJob) {
      return pipeline.captureAndCommit({ fileId: identifier(job.fileId, 'file id'), expectedRevision: expectedRevisionValue(job.expectedRevision) })
    },
  })
}

function serviceOrigin(value: string, label: string): string {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.origin !== value || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error(`${label} must use HTTPS outside loopback and contain no path or credentials.`)
  }
  return url.origin
}

function secret(value: string, label: string): string {
  if (new TextEncoder().encode(value).byteLength < 32 || /[\r\n]/.test(value)) throw new Error(`${label} is invalid.`)
  return value
}

function identifier(value: string, label: string): string {
  if (!identifierPattern.test(value)) throw new Error(`Invalid ${label}.`)
  return value
}

function expectedRevisionValue(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) throw new Error('Invalid expected revision.')
  return value
}

async function checked(response: Response, label: string): Promise<void> {
  if (response.status >= 300 && response.status < 400) throw new Error(`${label} redirects are not allowed.`)
  if (!response.ok) throw new Error(`${label} returned ${response.status}.`)
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}.`)
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== [...keys].sort().join(',')) throw new Error(`Invalid ${label}.`)
  return record
}

declare global {
  interface Window {
    __CANVAS_THUMBNAIL_SOURCE__?: Readonly<{ fileId: string; revision: number; pageId: string; registryFingerprint: string; file: unknown }>
    __PAPER_THUMBNAIL_READY?: boolean
  }
}
