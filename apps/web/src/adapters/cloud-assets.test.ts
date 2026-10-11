import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CloudAssetTransportError, createCloudAssetTransport } from './cloud-assets'
import type { ImageAssetReference } from '@canvas/repo-engine/appearance'

const fileId = 'file-1'
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])
const asset: ImageAssetReference = {
  id: 'asset-1',
  name: 'Pixel.png',
  mime: 'image/png',
  extension: 'png',
  bytes: bytes.byteLength,
  width: 1,
  height: 1,
  sha256: createHash('sha256').update(bytes).digest('hex'),
}
const requestId = '12345678-1234-4234-9234-123456789abc'

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: { 'X-Canvas-Request-Id': requestId, ...headers } })
}

function canonical() {
  const { name: _name, ...record } = asset
  return record
}

function intent(): Response {
  return json({
    method: 'PUT',
    path: '/file-assets/uploads',
    token: 'upload-token',
    headers: {
      'Content-Length': String(bytes.byteLength),
      'Content-Type': 'image/png',
      'X-Canvas-Upload-Token': 'upload-token',
    },
    expiresAt: '2030-01-01T00:00:00.000Z',
  }, 201)
}

function download(body = bytes, overrides: Record<string, string> = {}, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Length': String(body.byteLength),
      'Content-Type': asset.mime,
      'X-Canvas-Asset-Mime': asset.mime,
      'X-Canvas-Asset-Id': asset.id,
      'X-Canvas-Asset-Extension': asset.extension,
      'X-Canvas-Asset-Bytes': String(asset.bytes),
      'X-Canvas-Asset-Width': String(asset.width),
      'X-Canvas-Asset-Height': String(asset.height),
      'X-Canvas-Asset-Sha256': asset.sha256,
      'X-Canvas-Request-Id': requestId,
      ...overrides,
    },
  })
}

describe('cloud asset transport', () => {
  it('FILE-ASSET-LIFECYCLE-001 uploads, verifies, and downloads through the fixed credentialed origin', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      if (calls.length === 1) return intent()
      if (calls.length === 2) return json(canonical(), 201)
      return download()
    }) as typeof globalThis.fetch
    const transport = createCloudAssetTransport({ assetsOrigin: 'https://assets.canvas.test', fetch })
    await expect(transport.uploadImage({ fileId, asset, bytes })).resolves.toEqual(asset)
    expect(calls.map(call => `${call.init.method} ${call.url}`)).toEqual([
      'POST https://assets.canvas.test/file-assets/upload-intents',
      'PUT https://assets.canvas.test/file-assets/uploads',
      'GET https://assets.canvas.test/file-assets/file-1/asset-1.png',
    ])
    expect(calls.every(call => call.init.credentials === 'include' && call.init.redirect === 'manual')).toBe(true)
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ fileId, assetId: asset.id, extension: asset.extension, contentType: asset.mime, size: asset.bytes })
    expect(new Uint8Array(calls[1]!.init.body as ArrayBuffer)).toEqual(bytes)
  })

  it('FILE-ASSET-SEC-001 rejects non-origin configuration and cross-origin response locations', async () => {
    expect(() => createCloudAssetTransport({ assetsOrigin: 'https://assets.canvas.test/path' })).toThrow('origin')
    expect(() => createCloudAssetTransport({ assetsOrigin: 'http://assets.canvas.test' })).toThrow('HTTPS')
    const redirected = json(intent(), 200)
    Object.defineProperty(redirected, 'url', { value: 'https://attacker.test/file-assets/upload-intents' })
    const transport = createCloudAssetTransport({ assetsOrigin: 'https://assets.canvas.test', fetch: (async () => redirected) as typeof fetch })
    await expect(transport.uploadImage({ fileId, asset, bytes })).rejects.toMatchObject({ code: 'request_failed' })
  })

  it('FILE-ASSET-SEC-001 rejects oversized bodies and locally inconsistent digests before a request', async () => {
    let calls = 0
    const transport = createCloudAssetTransport({ assetsOrigin: 'https://assets.canvas.test', fetch: (async () => { calls += 1; return intent() }) as typeof fetch })
    const oversizedBytes = new Uint8Array(25 * 1024 * 1024 + 1)
    const oversized = { ...asset, bytes: oversizedBytes.byteLength }
    await expect(transport.uploadImage({ fileId, asset: oversized, bytes: oversizedBytes })).rejects.toMatchObject({ code: 'invalid_asset' })
    await expect(transport.uploadImage({ fileId, asset: { ...asset, sha256: '0'.repeat(64) }, bytes })).rejects.toMatchObject({ code: 'invalid_asset' })
    expect(calls).toBe(0)
  })

  it.each([
    ['length', { 'Content-Length': String(bytes.byteLength - 1) }],
    ['MIME', { 'Content-Type': 'image/webp', 'X-Canvas-Asset-Mime': 'image/webp' }],
    ['digest metadata', { 'X-Canvas-Asset-Sha256': '0'.repeat(64) }],
  ])('FILE-ASSET-SEC-001 rejects a downloaded object with a bad %s', async (_label, headers) => {
    const transport = createCloudAssetTransport({ assetsOrigin: 'https://assets.canvas.test', fetch: (async () => download(bytes, headers)) as typeof fetch })
    await expect(transport.downloadImage(fileId, asset)).rejects.toMatchObject({ code: 'verification_failed' })
  })

  it('FILE-ASSET-SEC-001 rejects downloaded bytes whose digest does not match verified metadata', async () => {
    const changed = bytes.slice()
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1
    const transport = createCloudAssetTransport({ assetsOrigin: 'https://assets.canvas.test', fetch: (async () => download(changed)) as typeof fetch })
    await expect(transport.downloadImage(fileId, asset)).rejects.toMatchObject({ code: 'verification_failed' })
  })

  it('FILE-ASSET-SEC-001 rejects malformed canonical upload records', async () => {
    let call = 0
    const transport = createCloudAssetTransport({
      assetsOrigin: 'https://assets.canvas.test',
      fetch: (async () => ++call === 1 ? intent() : json({ ...canonical(), unexpected: true }, 201)) as typeof fetch,
    })
    await expect(transport.uploadImage({ fileId, asset, bytes })).rejects.toMatchObject({ code: 'response_invalid' })
  })

  it('FILE-ASSET-LIFECYCLE-001 reconciles an exact object after the upload response is lost', async () => {
    let call = 0
    const transport = createCloudAssetTransport({
      assetsOrigin: 'https://assets.canvas.test',
      fetch: (async () => {
        call += 1
        if (call === 1) return intent()
        if (call === 2) throw new TypeError('connection lost after storage')
        return download()
      }) as typeof fetch,
    })
    await expect(transport.uploadImage({ fileId, asset, bytes })).resolves.toEqual(asset)
    expect(call).toBe(3)
  })

  it('FILE-ASSET-LIFECYCLE-001 fails closed when uncertain storage cannot be reconciled and sanitizes request IDs', async () => {
    let call = 0
    const missing = new Response(null, { status: 404, headers: { 'X-Canvas-Request-Id': '<script>Injected</script>' } })
    const transport = createCloudAssetTransport({
      assetsOrigin: 'https://assets.canvas.test',
      fetch: (async () => ++call === 1 ? intent() : call === 2 ? json({ error: 'conflict' }, 409) : missing) as typeof fetch,
    })
    const error = await transport.uploadImage({ fileId, asset, bytes }).catch(value => value)
    expect(error).toBeInstanceOf(CloudAssetTransportError)
    expect(error).toMatchObject({ code: 'not_confirmed' })
    expect(error.message).not.toContain('Injected')
    expect(error.message).toMatch(/Request ID: [0-9a-f-]{36}\./)
  })

  it('FILE-ASSET-LIFECYCLE-001 honors cancellation and stale-operation discard guards', async () => {
    const transport = createCloudAssetTransport({ assetsOrigin: 'https://assets.canvas.test', fetch: (async () => intent()) as typeof fetch })
    const controller = new AbortController()
    controller.abort()
    await expect(transport.uploadImage({ fileId, asset, bytes }, { signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' })
    await expect(transport.uploadImage({ fileId, asset, bytes }, { isCurrent: () => false })).rejects.toMatchObject({ code: 'discarded' })
  })
})
