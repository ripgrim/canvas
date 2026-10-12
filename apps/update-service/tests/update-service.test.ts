import { describe, expect, it } from 'vitest'
import { createUpdateHandler, updateObjectKey } from '../src/index'

const bucket = (bytes = new TextEncoder().encode('0123456789')) => ({
  async get(key: string, options?: Readonly<{ range?: { offset: number; length?: number } }>) {
    if (!key.endsWith('latest.yml') && !key.endsWith('.exe')) return null
    const range = options?.range
    const body = range ? bytes.slice(range.offset, range.offset + (range.length ?? bytes.length)) : bytes
    return { body: new Blob([body]).stream(), size: bytes.length, etag: 'etag', httpEtag: '"etag"', writeHttpMetadata(headers: Headers) { headers.set('Content-Type', key.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream') } }
  },
})

describe('UPDATE-FEED-001 public read-only update feed', () => {
  it('serves mutable manifests without caching and immutable installers with byte ranges', async () => {
    const handler = createUpdateHandler(bucket())
    const manifest = await handler(new Request('https://updates.test/windows/x64/latest.yml'))
    expect(manifest.status).toBe(200)
    expect(manifest.headers.get('cache-control')).toBe('no-store')

    const artifact = await handler(new Request('https://updates.test/windows/x64/Comp%20Canvas%20Setup%201.0.0.exe', { headers: { Range: 'bytes=2-5' } }))
    expect(artifact.status).toBe(206)
    expect(artifact.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await artifact.text()).toBe('2345')
    expect(artifact.headers.get('cache-control')).toContain('immutable')
  })

  it('rejects writes, traversal, arbitrary objects, and invalid ranges', async () => {
    const handler = createUpdateHandler(bucket())
    expect(updateObjectKey('/windows/x64/../secret')).toBeNull()
    expect(updateObjectKey('/windows/x64/debug.yml')).toBeNull()
    expect((await handler(new Request('https://updates.test/windows/x64/latest.yml', { method: 'PUT', body: 'bad' }))).status).toBe(405)
    expect((await handler(new Request('https://updates.test/windows/x64/Comp%20Canvas%20Setup%201.0.0.exe', { headers: { Range: 'bytes=99-100' } }))).status).toBe(416)
  })
})
