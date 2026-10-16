import { describe, expect, it } from 'vitest'
import { assertHostedPreviewArtifactAdmission, HostedPreviewArtifactReconciliationError, hostedPreviewCatalogFingerprint, parseHostedPreviewArtifactManifest, publishHostedPreviewArtifact, verifyHostedPreviewArtifactFiles } from '../src/hosted-artifact'
import type { HostedPreviewArtifactStageReceipt, HostedPreviewArtifactStorage } from '../src/hosted-artifact'

const sourceRevision = 'a'.repeat(40)
const registry = Object.freeze({ components: [{ componentId: 'shadcn:Button:1234567890abcdef', exportName: 'Button' }] })
const registryFingerprint = 'sha256:2ca6c5bfc27fcdfddb08bc0765c1253c26217f32ba29eb43adf7a3ea37a96738'
const manifest = Object.freeze({
  version: 1,
  sourceRevision,
  registryFingerprint,
  entrypoint: 'index.html',
  files: [
    { path: 'index.html', sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', bytes: 5, contentType: 'text/html; charset=utf-8' },
    { path: 'assets/components.js', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', bytes: 0, contentType: 'text/javascript; charset=utf-8' },
  ],
  components: [{ componentId: 'shadcn:Button:1234567890abcdef', modulePath: 'assets/components.js', exportName: 'Button' }],
})
const expectation = Object.freeze({ sourceRevision, registryFingerprint, components: registry.components })
const files = () => new Map([
  ['index.html', new TextEncoder().encode('hello')],
  ['assets/components.js', new Uint8Array()],
])
const artifactId = '00000000-0000-4000-8000-000000000101'
const stagingId = '00000000-0000-4000-8000-000000000201'
const secondStagingId = '00000000-0000-4000-8000-000000000202'

function memoryStorage() {
  type Attempt = {
    receipt: HostedPreviewArtifactStageReceipt
    state: 'staged' | 'published'
    files: ReadonlyMap<string, Uint8Array>
  }
  const attempts = new Map<string, Attempt>()
  const storage: HostedPreviewArtifactStorage = {
    async stage(input) {
      if (attempts.has(input.artifactId)) throw new Error('artifact collision')
      const receipt = Object.freeze({ artifactId: input.artifactId, stagingId: input.stagingId })
      attempts.set(input.artifactId, { receipt, state: 'staged', files: new Map(input.files) })
    },
    async publish(receipt) {
      const attempt = attempts.get(receipt.artifactId)
      if (!attempt || attempt.receipt.stagingId !== receipt.stagingId) throw new Error('staging attempt missing')
      attempt.state = 'published'
    },
    async status(receipt) {
      const attempt = attempts.get(receipt.artifactId)
      return !attempt || attempt.receipt.stagingId !== receipt.stagingId ? 'missing' : attempt.state
    },
    async discard(receipt) {
      const attempt = attempts.get(receipt.artifactId)
      if (attempt?.receipt.stagingId === receipt.stagingId && attempt.state === 'staged') attempts.delete(receipt.artifactId)
    },
  }
  return {
    storage,
    visible(id: string) { return attempts.get(id)?.state === 'published' },
    bytes(id: string, path: string) { return attempts.get(id)?.files.get(path) },
    has(id: string) { return attempts.has(id) },
  }
}

describe('hosted preview artifact admission', () => {
  it('COMP-V2-CODE-003 accepts only an exact immutable file and component set', () => {
    const parsed = parseHostedPreviewArtifactManifest(manifest)
    expect(hostedPreviewCatalogFingerprint(registry)).toBe(registryFingerprint)
    expect(() => assertHostedPreviewArtifactAdmission(parsed, expectation)).not.toThrow()
    expect(() => verifyHostedPreviewArtifactFiles(parsed, files())).not.toThrow()
  })

  it('COMP-V2-CODE-003 rejects path traversal, mismatched lineage, omitted bindings, and changed bytes', () => {
    expect(() => parseHostedPreviewArtifactManifest({ ...manifest, entrypoint: '../index.html' })).toThrow('invalid')
    expect(() => parseHostedPreviewArtifactManifest({ ...manifest, registryFingerprint: `sha256:${'b'.repeat(64)}` })).not.toThrow()
    const parsed = parseHostedPreviewArtifactManifest(manifest)
    expect(() => assertHostedPreviewArtifactAdmission(parsed, { sourceRevision: 'b'.repeat(40), registryFingerprint, components: registry.components })).toThrow('invalid')
    expect(() => assertHostedPreviewArtifactAdmission(parsed, { sourceRevision, registryFingerprint: `sha256:${'b'.repeat(64)}`, components: registry.components })).toThrow('invalid')
    expect(() => assertHostedPreviewArtifactAdmission(parsed, { sourceRevision, registryFingerprint, components: [{ ...registry.components[0], exportName: 'Card' }] })).toThrow('invalid')
    expect(() => assertHostedPreviewArtifactAdmission(parsed, { sourceRevision, registryFingerprint, components: [...registry.components, registry.components[0]] })).toThrow('invalid')
    expect(() => verifyHostedPreviewArtifactFiles(parsed, new Map([
      ['index.html', new TextEncoder().encode('HELLO')],
      ['assets/components.js', new Uint8Array()],
    ]))).toThrow('invalid')
  })

  it('COMP-V2-CODE-003 rejects undeclared files and non-JavaScript component modules', () => {
    const parsed = parseHostedPreviewArtifactManifest(manifest)
    expect(() => verifyHostedPreviewArtifactFiles(parsed, new Map([
      ['index.html', new TextEncoder().encode('hello')],
      ['assets/components.js', new Uint8Array()],
      ['assets/extra.js', new Uint8Array()],
    ]))).toThrow('invalid')
    expect(() => parseHostedPreviewArtifactManifest({ ...manifest, components: [{ ...manifest.components[0], modulePath: 'index.html' }] })).toThrow('invalid')
    expect(() => parseHostedPreviewArtifactManifest({ ...manifest, files: [manifest.files[0], { ...manifest.files[1], path: 'assets/components.css' }], components: [{ ...manifest.components[0], modulePath: 'assets/components.css' }] })).toThrow('invalid')
    expect(() => parseHostedPreviewArtifactManifest({ ...manifest, files: [{ ...manifest.files[0], path: 'index.html?download=1' }, manifest.files[1]] })).toThrow('invalid')
  })

  it('COMP-V2-CODE-003 rejects duplicate identities, unknown fields, unsupported types, and traversal', () => {
    expect(() => parseHostedPreviewArtifactManifest({ ...manifest, extra: true })).toThrow('invalid')
    expect(() => parseHostedPreviewArtifactManifest({ ...manifest, files: [{ ...manifest.files[0], extra: true }, manifest.files[1]] })).toThrow('invalid')
    expect(() => parseHostedPreviewArtifactManifest({ ...manifest, components: [{ ...manifest.components[0], extra: true }] })).toThrow('invalid')
    expect(() => parseHostedPreviewArtifactManifest({ ...manifest, files: [manifest.files[0], manifest.files[0], manifest.files[1]] })).toThrow('invalid')
    expect(() => parseHostedPreviewArtifactManifest({ ...manifest, components: [manifest.components[0], manifest.components[0]] })).toThrow('invalid')
    expect(() => parseHostedPreviewArtifactManifest({ ...manifest, files: [{ ...manifest.files[0], contentType: 'application/wasm' }, manifest.files[1]] })).toThrow('invalid')
    expect(() => parseHostedPreviewArtifactManifest({ ...manifest, files: [manifest.files[0], { ...manifest.files[1], path: 'assets/../escape.js' }] })).toThrow('invalid')
    expect(() => parseHostedPreviewArtifactManifest({ ...manifest, components: [{ ...manifest.components[0], modulePath: '../escape.js' }] })).toThrow('invalid')
    const unsafeBinding = Object.create(null)
    Object.defineProperties(unsafeBinding, {
      componentId: { enumerable: true, value: manifest.components[0].componentId },
      modulePath: { enumerable: true, value: manifest.components[0].modulePath },
      exportName: { enumerable: true, get() { throw new Error('accessed') } },
    })
    expect(() => parseHostedPreviewArtifactManifest({ ...manifest, components: [unsafeBinding] })).toThrow('invalid')
  })

  it('COMP-V2-CODE-003 enforces declared lengths, complete bytes, and file limits', () => {
    const parsed = parseHostedPreviewArtifactManifest(manifest)
    expect(() => verifyHostedPreviewArtifactFiles(parsed, new Map([['index.html', new TextEncoder().encode('hello')]]))).toThrow('invalid')
    expect(() => verifyHostedPreviewArtifactFiles(parsed, new Map([
      ['index.html', new TextEncoder().encode('hell')],
      ['assets/components.js', new Uint8Array()],
    ]))).toThrow('invalid')
    expect(() => parseHostedPreviewArtifactManifest({ ...manifest, files: [{ ...manifest.files[0], bytes: 8 * 1024 * 1024 + 1 }, manifest.files[1]] })).toThrow('invalid')
    const oversized = Array.from({ length: 9 }, (_, index) => ({ path: index === 0 ? 'index.html' : `assets/file-${index}.js`, sha256: 'a'.repeat(64), bytes: 8 * 1024 * 1024, contentType: index === 0 ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' }))
    expect(() => parseHostedPreviewArtifactManifest({ ...manifest, files: oversized })).toThrow('invalid')
    expect(() => parseHostedPreviewArtifactManifest({ ...manifest, files: Array.from({ length: 10_001 }, (_, index) => ({ ...manifest.files[0], path: `file-${index}.html` })) })).toThrow('invalid')
    expect(() => parseHostedPreviewArtifactManifest({ ...manifest, components: Array.from({ length: 5_001 }, (_, index) => ({ componentId: `component:${index}`, modulePath: 'assets/components.js', exportName: 'Button' })) })).toThrow('invalid')
  })

  it('COMP-V2-CODE-003 rejects invalid canonical catalog input without executing accessors', () => {
    expect(() => hostedPreviewCatalogFingerprint({ value: undefined })).toThrow('invalid')
    expect(() => hostedPreviewCatalogFingerprint({ get value() { throw new Error('accessed') } })).toThrow('invalid')
    expect(() => hostedPreviewCatalogFingerprint(Array(1))).toThrow('invalid')
    const arrayWithGetter: unknown[] = []
    Object.defineProperty(arrayWithGetter, '0', { enumerable: true, get() { throw new Error('accessed') } })
    Object.defineProperty(arrayWithGetter, 'length', { value: 1 })
    expect(() => hostedPreviewCatalogFingerprint(arrayWithGetter)).toThrow('invalid')
    const arrayWithExtra = [1] as unknown[] & { extra?: boolean }
    arrayWithExtra.extra = true
    expect(() => hostedPreviewCatalogFingerprint(arrayWithExtra)).toThrow('invalid')
    expect(() => hostedPreviewCatalogFingerprint({ [Symbol('hidden')]: true })).toThrow('invalid')
  })

  it('COMP-V2-CODE-003 verifies before staging and publishes one immutable artifact', async () => {
    const memory = memoryStorage()
    const inputFiles = files()
    const publication = publishHostedPreviewArtifact({ artifactId, stagingId, manifest, expectation, files: inputFiles }, memory.storage)
    inputFiles.get('index.html')!.fill(0)
    const artifact = await publication
    expect(artifact).toMatchObject({ artifactId, manifest: { sourceRevision, registryFingerprint } })
    expect(memory.visible(artifactId)).toBe(true)
    expect(new TextDecoder().decode(memory.bytes(artifactId, 'index.html'))).toBe('hello')
  })

  it('COMP-V2-CODE-003 performs no storage operation for invalid trust input or artifact identity', async () => {
    const calls: string[] = []
    const storage: HostedPreviewArtifactStorage = {
      async stage() { calls.push('stage'); throw new Error('unexpected') },
      async publish() { calls.push('publish') },
      async status() { calls.push('status'); return 'missing' },
      async discard() { calls.push('discard') },
    }
    await expect(publishHostedPreviewArtifact({ artifactId, stagingId, manifest: { ...manifest, sourceRevision: 'b'.repeat(40) }, expectation, files: files() }, storage)).rejects.toThrow('invalid')
    await expect(publishHostedPreviewArtifact({ artifactId: 'not-an-id', stagingId, manifest, expectation, files: files() }, storage)).rejects.toThrow('invalid')
    await expect(publishHostedPreviewArtifact({ artifactId, stagingId: 'not-an-id', manifest, expectation, files: files() }, storage)).rejects.toThrow('invalid')
    expect(calls).toEqual([])
  })

  it('COMP-V2-CODE-003 preserves an existing published artifact when create-only staging collides', async () => {
    const memory = memoryStorage()
    await publishHostedPreviewArtifact({ artifactId, stagingId, manifest, expectation, files: files() }, memory.storage)
    await expect(publishHostedPreviewArtifact({ artifactId, stagingId: secondStagingId, manifest, expectation, files: files() }, memory.storage)).rejects.toThrow('collision')
    expect(memory.visible(artifactId)).toBe(true)
  })

  it('COMP-V2-CODE-003 never reconciles a deterministic staging rejection as success', async () => {
    const calls: string[] = []
    const storage: HostedPreviewArtifactStorage = {
      async stage() { calls.push('stage'); throw new Error('manifest collision') },
      async publish() { calls.push('publish') },
      async status() { calls.push('status'); return 'published' },
      async discard() { calls.push('discard') },
    }
    await expect(publishHostedPreviewArtifact({ artifactId, stagingId, manifest, expectation, files: files() }, storage)).rejects.toThrow('manifest collision')
    expect(calls).toEqual(['stage'])
  })

  it('COMP-V2-CODE-003 discards private bytes when publication fails before visibility', async () => {
    const memory = memoryStorage()
    const calls: string[] = []
    const storage: HostedPreviewArtifactStorage = {
      ...memory.storage,
      async publish() { calls.push('publish'); throw new Error('visibility failed') },
      async status(receipt) { calls.push('status'); return memory.storage.status(receipt) },
      async discard(receipt) { calls.push('discard'); return memory.storage.discard(receipt) },
    }
    await expect(publishHostedPreviewArtifact({ artifactId, stagingId, manifest, expectation, files: files() }, storage)).rejects.toThrow('visibility failed')
    expect(calls).toEqual(['publish', 'status', 'discard'])
    expect(memory.has(artifactId)).toBe(false)
  })

  it('COMP-V2-CODE-003 reconciles a lost acknowledgement after visibility without discarding', async () => {
    const memory = memoryStorage()
    const calls: string[] = []
    const storage: HostedPreviewArtifactStorage = {
      ...memory.storage,
      async publish(receipt) {
        calls.push('publish')
        await memory.storage.publish(receipt)
        throw new Error('acknowledgement lost')
      },
      async status(receipt) { calls.push('status'); return memory.storage.status(receipt) },
      async discard(receipt) { calls.push('discard'); return memory.storage.discard(receipt) },
    }
    await expect(publishHostedPreviewArtifact({ artifactId, stagingId, manifest, expectation, files: files() }, storage)).resolves.toMatchObject({ artifactId })
    expect(calls).toEqual(['publish', 'status'])
    expect(memory.visible(artifactId)).toBe(true)
  })

  it('COMP-V2-CODE-003 resumes publication after a lost staging acknowledgement', async () => {
    const memory = memoryStorage()
    const calls: string[] = []
    let attempts = 0
    const storage: HostedPreviewArtifactStorage = {
      ...memory.storage,
      async stage(input) {
        calls.push('stage')
        attempts += 1
        if (attempts === 1) {
          await memory.storage.stage(input)
          throw new HostedPreviewArtifactReconciliationError([new Error('staging acknowledgement lost')])
        }
      },
      async status(receipt) { calls.push('status'); return memory.storage.status(receipt) },
      async publish(receipt) { calls.push('publish'); return memory.storage.publish(receipt) },
    }
    await expect(publishHostedPreviewArtifact({ artifactId, stagingId, manifest, expectation, files: files() }, storage)).resolves.toMatchObject({ artifactId })
    expect(calls).toEqual(['stage', 'stage', 'publish'])
    expect(memory.visible(artifactId)).toBe(true)
  })

  it('COMP-V2-CODE-003 reports publication and cleanup failures together', async () => {
    const memory = memoryStorage()
    const storage: HostedPreviewArtifactStorage = {
      ...memory.storage,
      async publish() { throw new Error('visibility failed') },
      async discard() { throw new Error('cleanup failed') },
    }
    const failure = await publishHostedPreviewArtifact({ artifactId, stagingId, manifest, expectation, files: files() }, storage).catch(error => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors.map((error: Error) => error.message)).toEqual(['visibility failed', 'cleanup failed'])
  })

  it('COMP-V2-CODE-003 keeps the staged attempt when publication status is unknown', async () => {
    const calls: string[] = []
    const memory = memoryStorage()
    const storage: HostedPreviewArtifactStorage = {
      ...memory.storage,
      async publish() { calls.push('publish'); throw new Error('visibility failed') },
      async status() { calls.push('status'); throw new Error('status unavailable') },
      async discard() { calls.push('discard') },
    }
    const failure = await publishHostedPreviewArtifact({ artifactId, stagingId, manifest, expectation, files: files() }, storage).catch(error => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors.map((error: Error) => error.message)).toEqual(['visibility failed', 'status unavailable'])
    expect(calls).toEqual(['publish', 'status'])
    expect(memory.has(artifactId)).toBe(true)
  })

  it('COMP-V2-CODE-003 relies on rejected create-only staging to leave no attempt', async () => {
    const calls: string[] = []
    const storage: HostedPreviewArtifactStorage = {
      async stage() { calls.push('stage'); throw new Error('stage failed') },
      async publish() { calls.push('publish') },
      async status() { calls.push('status'); return 'missing' },
      async discard() { calls.push('discard') },
    }
    await expect(publishHostedPreviewArtifact({ artifactId, stagingId, manifest, expectation, files: files() }, storage)).rejects.toThrow('stage failed')
    expect(calls).toEqual(['stage'])
  })
})
