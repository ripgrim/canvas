import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBlankFile } from '@canvas/repo-engine/file-document'
import { loadVerifiedRegistryManifest } from '../../../packages/preview-runtime/src/verified-registry.mjs'
import { createPlaywrightThumbnailCapturePort } from '../src/index.js'

let rendererOrigin = ''
const fileId = '11111111-2222-4333-8444-555555555555'
const document = createBlankFile(fileId, 'page_thumbnail', 'root_thumbnail', 'Page 1')
let renderer: ChildProcess | undefined
let rendererOutput = ''
const manifest = fileURLToPath(new URL('../../thumbnail-renderer/tests/verified-registry.json', import.meta.url))
const registry = await loadVerifiedRegistryManifest(manifest)
if (!registry) throw new Error('Thumbnail registry fixture is unavailable.')

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate a thumbnail renderer port.')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

async function ready(): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try { if ((await fetch(`${rendererOrigin}/thumbnail-renderer`)).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Thumbnail renderer did not start.\n${rendererOutput}`)
}

beforeAll(async () => {
  const port = await availablePort()
  rendererOrigin = `http://127.0.0.1:${port}`
  const vite = fileURLToPath(new URL('../../thumbnail-renderer/node_modules/vite/bin/vite.js', import.meta.url))
  renderer = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: fileURLToPath(new URL('../../thumbnail-renderer', import.meta.url)),
    env: { ...process.env, CANVAS_VERIFIED_COMPONENT_REGISTRY: manifest },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  renderer.stdout?.on('data', value => { rendererOutput += String(value) })
  renderer.stderr?.on('data', value => { rendererOutput += String(value) })
  try { await ready() } catch (error) { renderer.kill(); throw error }
}, 20_000)

afterAll(() => renderer?.kill())

describe('real thumbnail capture', () => {
  it('AT-THUMB-001 waits for the isolated renderer and returns a decodable AVIF', async () => {
    const capture = createPlaywrightThumbnailCapturePort({
      rendererOrigin,
      source: { async read() { return { fileId, revision: 0, pageId: 'page_thumbnail', registryFingerprint: registry.fingerprint, document } } },
    })
    const bytes = await capture.capture({ fileId, expectedRevision: 0, contentType: 'image/avif', maxWidth: 1024, maxHeight: 768 })
    expect(bytes.byteLength).toBeGreaterThan(100)
    expect(bytes.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(new TextDecoder().decode(bytes.subarray(4, 12))).toBe('ftypavif')
  }, 20_000)
})
