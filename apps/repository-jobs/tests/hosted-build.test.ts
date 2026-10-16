import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { HostedPreviewArtifactStorage } from '@canvas/preview-runtime/hosted-artifact'
import { scanShadcnPreviewRegistry } from '@canvas/scanner/preview-registry'
import { createHostedPreviewBuildPublisher, createHttpHostedPreviewArtifactStorage, createHttpHostedPreviewRegistrar } from '../src/hosted-build.js'
import type { HostedPreviewSandboxInput } from '../src/hosted-build.js'

const createPublisher = (options: Parameters<typeof createHostedPreviewBuildPublisher>[0]) => createHostedPreviewBuildPublisher({
  ...options,
  verifyClosure: vi.fn(async () => undefined),
})

const artifactId = '00000000-0000-4000-8000-000000000301'
const stagingId = '00000000-0000-4000-8000-000000000302'
const fileId = '00000000-0000-4000-8000-000000000303'
const sourceRevision = 'a'.repeat(40)
const sourceHash = 'b'.repeat(64)
const componentId = 'shadcn:Button:8f9171d59b1041d3'
const registryFingerprint = 'sha256:78892a58d1973adad9183c4b14f2a1cbb78464cc42c065fa99d37aa80deddb70'
const scan = Object.freeze({
  sourceRevision,
  scan: Object.freeze({ adapterId: 'shadcn-v1' as const, configs: [], components: [{ path: 'src/button.tsx', exportName: 'Button', packageName: '@acme/ui', declarationKind: 'function' as const, props: [], slots: [], sourceHash, fingerprint: 'c'.repeat(64) }], tokens: [], sourceHashes: { 'src/button.tsx': sourceHash }, diagnostics: [] }),
  request: Object.freeze({ version: 1 as const, entry: { componentId }, components: [{ componentId, entryPath: 'src/button.tsx', exportName: 'Button', integrity: `sha256-${Buffer.from(sourceHash, 'hex').toString('base64')}`, props: {}, slots: [] }], styles: [] }),
})
const files = new Map([
  ['index.html', new TextEncoder().encode('hello')],
  ['assets/components.js', new Uint8Array()],
])
const manifest = Object.freeze({
  version: 1 as const,
  sourceRevision,
  registryFingerprint,
  entrypoint: 'index.html',
  files: [
    { path: 'index.html', sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', bytes: 5, contentType: 'text/html; charset=utf-8' as const },
    { path: 'assets/components.js', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', bytes: 0, contentType: 'text/javascript; charset=utf-8' as const },
  ],
  components: [{ componentId, modulePath: 'assets/components.js', exportName: 'Button' }],
})

function storage(events: string[]): HostedPreviewArtifactStorage {
  let state: 'missing' | 'staged' | 'published' = 'missing'
  return {
    async stage() { events.push('stage'); state = 'staged' },
    async publish() { events.push('publish'); state = 'published' },
    async status() { return state },
    async discard() { events.push('discard'); state = 'missing' },
  }
}

describe('hosted preview build publisher', () => {
  it('COMP-V2-CODE-010 rejects a changed checkout before sandbox execution', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'design-editor-publisher-closure-'))
    try {
      await mkdir(path.join(root, 'src/components/ui'), { recursive: true })
      await mkdir(path.join(root, 'src/lib'), { recursive: true })
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'publisher-closure', private: true }), 'utf8')
      await writeFile(path.join(root, 'components.json'), JSON.stringify({ aliases: { ui: '@/components/ui' }, tailwind: { css: 'src/globals.css' } }), 'utf8')
      await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }), 'utf8')
      await writeFile(path.join(root, 'src/globals.css'), ':root { --surface: #fff; }\n', 'utf8')
      await writeFile(path.join(root, 'src/lib/label.ts'), `export const label = 'Original'\n`, 'utf8')
      await writeFile(path.join(root, 'src/components/ui/button.tsx'), `import { label } from '@/lib/label'\nexport function Button() { return <button>{label}</button> }\n`, 'utf8')
      const generated = await scanShadcnPreviewRegistry(root)
      await writeFile(path.join(root, 'src/lib/label.ts'), `export const label = 'Changed'\n`, 'utf8')

      const build = vi.fn()
      const stage = vi.fn()
      const publish = vi.fn()
      const status = vi.fn()
      const discard = vi.fn()
      const register = vi.fn()
      const publisher = createHostedPreviewBuildPublisher({
        sandbox: { build },
        storage: { stage, publish, status, discard },
        registrar: { register },
      })

      await expect(publisher.build({
        artifactId,
        stagingId,
        fileId,
        fileRevision: 1,
        repositoryRoot: root,
        scan: { sourceRevision, ...generated },
      })).rejects.toThrow('Repository preview dependency closure changed.')
      expect(build).not.toHaveBeenCalled()
      expect(stage).not.toHaveBeenCalled()
      expect(publish).not.toHaveBeenCalled()
      expect(status).not.toHaveBeenCalled()
      expect(discard).not.toHaveBeenCalled()
      expect(register).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('COMP-V2-CODE-012 transports only one capability-bound artifact identity', async () => {
    const requests: Request[] = []
    const jobId = '00000000-0000-4000-8000-000000000304'
    const leaseId = '00000000-0000-4000-8000-000000000305'
    const capability = 'header.payload'
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      const action = new URL(request.url).pathname.split('/').at(-1)
      return Response.json({ status: action === 'file' ? 'uploaded' : action === 'commit' ? 'staged' : action === 'publish' ? 'published' : action === 'discard' ? 'discarded' : 'published' }, { status: action === 'file' || action === 'commit' ? 201 : 200 })
    })
    const remote = createHttpHostedPreviewArtifactStorage({ origin: 'https://assets.canvas.test', capability, jobId, leaseId, artifactId, stagingId, fetch })
    await remote.stage({ artifactId, stagingId, manifest, files })
    await remote.publish({ artifactId, stagingId })
    await expect(remote.status({ artifactId, stagingId })).resolves.toBe('published')
    await remote.discard({ artifactId, stagingId })
    await expect(remote.publish({ artifactId: crypto.randomUUID(), stagingId })).rejects.toThrow('identity')

    expect(requests.map(request => new URL(request.url).pathname.split('/').at(-1))).toEqual(['file', 'file', 'commit', 'publish', 'status', 'discard'])
    for (const request of requests) {
      expect(request.headers.get('x-canvas-hosted-preview-job-id')).toBe(jobId)
      expect(request.headers.get('x-canvas-hosted-preview-lease-id')).toBe(leaseId)
      expect(request.headers.get('x-canvas-hosted-preview-write-capability')).toBe(capability)
      expect(request.headers.get('authorization')).toBeNull()
      expect(request.headers.get('cookie')).toBeNull()
    }
    expect(requests[0]!.headers.get('x-canvas-artifact-path')).toBe('index.html')
    expect(requests[0]!.headers.get('x-canvas-artifact-bytes')).toBe('5')
  })

  it('COMP-V2-CODE-012 replays the exact committed stage after its acknowledgement is lost', async () => {
    let state: 'missing' | 'staged' | 'published' = 'missing'
    let commitAttempts = 0
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      const action = new URL(String(input)).pathname.split('/').at(-1)
      if (action === 'file') return Response.json({ status: 'uploaded' }, { status: 201 })
      if (action === 'commit') {
        commitAttempts += 1
        state = 'staged'
        if (commitAttempts === 1) throw new TypeError('commit acknowledgement lost')
        return Response.json({ status: 'staged' }, { status: 201 })
      }
      if (action === 'publish') {
        state = 'published'
        return Response.json({ status: 'published' })
      }
      throw new Error('Unexpected transport action.')
    })
    const remote = createHttpHostedPreviewArtifactStorage({
      origin: 'https://assets.canvas.test',
      capability: 'header.payload',
      jobId: '00000000-0000-4000-8000-000000000304',
      leaseId: '00000000-0000-4000-8000-000000000305',
      artifactId,
      stagingId,
      fetch,
    })
    const register = vi.fn(async () => undefined)
    const publisher = createPublisher({
      sandbox: { async build() { return { manifest, files } } },
      storage: remote,
      registrar: { register },
    })

    await expect(publisher.build({ artifactId, stagingId, fileId, fileRevision: 4, repositoryRoot: 'C:/sandbox/repository', scan })).resolves.toEqual({ artifactId, entrypoint: 'index.html' })

    expect(commitAttempts).toBe(2)
    expect(state).toBe('published')
    expect(register).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).pathname.split('/').at(-1))).toEqual(['file', 'file', 'commit', 'file', 'file', 'commit', 'publish'])
  })

  it('COMP-V2-CODE-012 replays an uncertain file upload with identical bytes', async () => {
    const uploadedBodies: Uint8Array[] = []
    let firstFileAttempts = 0
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = new Request(input, init)
      const action = new URL(request.url).pathname.split('/').at(-1)
      if (action === 'file') {
        if (request.headers.get('x-canvas-artifact-path') === 'index.html') {
          firstFileAttempts += 1
          uploadedBodies.push(new Uint8Array(await request.arrayBuffer()))
          if (firstFileAttempts === 1) throw new TypeError('file acknowledgement lost')
        }
        return Response.json({ status: 'uploaded' }, { status: 201 })
      }
      if (action === 'commit') return Response.json({ status: 'staged' }, { status: 201 })
      if (action === 'publish') return Response.json({ status: 'published' })
      throw new Error('Unexpected transport action.')
    })
    const remote = createHttpHostedPreviewArtifactStorage({
      origin: 'https://assets.canvas.test', capability: 'header.payload',
      jobId: '00000000-0000-4000-8000-000000000304', leaseId: '00000000-0000-4000-8000-000000000305',
      artifactId, stagingId, fetch,
    })
    const publisher = createPublisher({
      sandbox: { async build() { return { manifest, files } } }, storage: remote, registrar: { async register() {} },
    })

    await expect(publisher.build({ artifactId, stagingId, fileId, fileRevision: 4, repositoryRoot: 'C:/sandbox/repository', scan })).resolves.toEqual({ artifactId, entrypoint: 'index.html' })

    expect(firstFileAttempts).toBe(2)
    expect(uploadedBodies).toHaveLength(2)
    expect(uploadedBodies[1]).toEqual(uploadedBodies[0])
  })

  it('COMP-V2-CODE-012 never reconciles a deterministic artifact rejection', async () => {
    const fetch = vi.fn(async () => Response.json({ error: 'conflict' }, { status: 409 }))
    const remote = createHttpHostedPreviewArtifactStorage({
      origin: 'https://assets.canvas.test', capability: 'header.payload',
      jobId: '00000000-0000-4000-8000-000000000304', leaseId: '00000000-0000-4000-8000-000000000305',
      artifactId, stagingId, fetch,
    })

    await expect(remote.stage({ artifactId, stagingId, manifest, files })).rejects.toThrow('409')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('COMP-V2-CODE-009 publishes verified sandbox output before registering it', async () => {
    const events: string[] = []
    const build = vi.fn(async (_input: HostedPreviewSandboxInput) => { events.push('build'); return { manifest, files } })
    const register = vi.fn(async () => { events.push('register') })
    const publisher = createPublisher({ sandbox: { build }, storage: storage(events), registrar: { register } })

    await expect(publisher.build({ artifactId, stagingId, fileId, fileRevision: 4, repositoryRoot: 'C:/sandbox/repository', scan })).resolves.toEqual({ artifactId, entrypoint: 'index.html' })

    expect(events).toEqual(['build', 'stage', 'publish', 'register'])
    expect(build).toHaveBeenCalledWith({ artifactId, repositoryRoot: 'C:/sandbox/repository', sourceRevision, registryFingerprint, request: scan.request })
    expect(Object.keys(build.mock.calls[0]![0]).sort()).toEqual(['artifactId', 'registryFingerprint', 'repositoryRoot', 'request', 'sourceRevision'])
    expect(register).toHaveBeenCalledWith({ artifactId, fileId, fileRevision: 4, sourceRevision, registryFingerprint, entrypoint: 'index.html' })
  })

  it('COMP-V2-CODE-009 never stages or registers mismatched sandbox output', async () => {
    const events: string[] = []
    const register = vi.fn()
    const publisher = createPublisher({
      sandbox: { async build() { events.push('build'); return { manifest: { ...manifest, sourceRevision: 'd'.repeat(40) }, files } } },
      storage: storage(events),
      registrar: { register },
    })

    await expect(publisher.build({ artifactId, stagingId, fileId, fileRevision: 4, repositoryRoot: 'C:/sandbox/repository', scan })).rejects.toThrow('invalid')
    expect(events).toEqual(['build'])
    expect(register).not.toHaveBeenCalled()
  })

  it('COMP-V2-CODE-009 rejects invalid binding identity before sandbox execution', async () => {
    const build = vi.fn()
    const publisher = createPublisher({ sandbox: { build }, storage: storage([]), registrar: { register: vi.fn() } })
    await expect(publisher.build({ artifactId, stagingId, fileId: 'wrong-file', fileRevision: 4, repositoryRoot: 'C:/sandbox/repository', scan })).rejects.toThrow('invalid')
    expect(build).not.toHaveBeenCalled()
  })

  it('COMP-V2-CODE-009 registers through the dedicated publisher credential', async () => {
    const input = { artifactId, fileId, fileRevision: 4, sourceRevision, registryFingerprint, entrypoint: 'index.html' }
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => Response.json({ artifact: input }, { status: 201 }))
    const registrar = createHttpHostedPreviewRegistrar({ apiOrigin: 'https://api.canvas.test', serviceToken: 'publisher-token-0123456789abcdef0123456789', fetch })

    await expect(registrar.register(input)).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledWith(new URL('https://api.canvas.test/internal/hosted-previews/register'), expect.objectContaining({
      method: 'POST',
      credentials: 'omit',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', 'X-Canvas-Hosted-Preview-Publisher-Token': 'publisher-token-0123456789abcdef0123456789' },
      body: JSON.stringify(input),
    }))
  })

  it('COMP-V2-CODE-009 rejects redirected and mismatched registration responses', async () => {
    const input = { artifactId, fileId, fileRevision: 4, sourceRevision, registryFingerprint, entrypoint: 'index.html' }
    const create = (response: Response) => createHttpHostedPreviewRegistrar({
      apiOrigin: 'https://api.canvas.test',
      serviceToken: 'publisher-token-0123456789abcdef0123456789',
      fetch: vi.fn(async () => response),
    })
    await expect(create(new Response(null, { status: 302 })).register(input)).rejects.toThrow('302')
    await expect(create(Response.json({ artifact: { ...input, fileRevision: 5 } })).register(input)).rejects.toThrow('invalid')
  })

  it('COMP-V2-CODE-009 passes only the canonical frozen scan request into the sandbox', async () => {
    const mutableScan = structuredClone(scan)
    let received: HostedPreviewSandboxInput | undefined
    const publisher = createPublisher({
      sandbox: {
        async build(input) {
          received = input
          Reflect.set(mutableScan.request.components[0]!, 'exportName', 'Card')
          Object.defineProperty(mutableScan.request, 'credential', { value: 'must-not-cross-sandbox-boundary', enumerable: false })
          return { manifest, files }
        },
      },
      storage: storage([]),
      registrar: { register: vi.fn() },
    })

    await publisher.build({ artifactId, stagingId, fileId, fileRevision: 4, repositoryRoot: 'C:/sandbox/repository', scan: mutableScan })

    expect(received?.request.components[0]?.exportName).toBe('Button')
    expect(Reflect.has(received?.request ?? {}, 'credential')).toBe(false)
    expect(Object.keys(received?.request ?? {}).sort()).toEqual(['components', 'entry', 'styles', 'version'])
    expect(Object.isFrozen(received?.request)).toBe(true)
    expect(Object.isFrozen(received?.request.components)).toBe(true)
    expect(Object.isFrozen(received?.request.components[0])).toBe(true)
  })

  it('COMP-V2-CODE-009 bounds and type-checks registrar responses', async () => {
    const input = { artifactId, fileId, fileRevision: 4, sourceRevision, registryFingerprint, entrypoint: 'index.html' }
    const create = (response: Response) => createHttpHostedPreviewRegistrar({
      apiOrigin: 'https://api.canvas.test',
      serviceToken: 'publisher-token-0123456789abcdef0123456789',
      fetch: vi.fn(async () => response),
    })

    await expect(create(new Response(JSON.stringify({ artifact: input }), { headers: { 'Content-Type': 'text/plain' } })).register(input)).rejects.toThrow('invalid')
    await expect(create(new Response('x'.repeat(32 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } })).register(input)).rejects.toThrow('invalid')
  })

  it('COMP-V2-CODE-009 retries an uncertain registration with the same persisted artifact identities', async () => {
    const events: string[] = []
    let state: 'missing' | 'staged' | 'published' = 'missing'
    const retryableStorage: HostedPreviewArtifactStorage = {
      async stage(input) {
        events.push(`stage:${input.artifactId}:${input.stagingId}`)
        if (state === 'missing') state = 'staged'
      },
      async publish(receipt) {
        events.push(`publish:${receipt.artifactId}:${receipt.stagingId}`)
        state = 'published'
      },
      async status() { return state },
      async discard() { state = 'missing' },
    }
    const register = vi.fn()
      .mockRejectedValueOnce(new Error('Registration acknowledgement was lost.'))
      .mockResolvedValueOnce(undefined)
    const publisher = createPublisher({
      sandbox: { async build() { return { manifest, files } } },
      storage: retryableStorage,
      registrar: { register },
    })
    const request = { artifactId, stagingId, fileId, fileRevision: 4, repositoryRoot: 'C:/sandbox/repository', scan }

    await expect(publisher.build(request)).rejects.toThrow('acknowledgement')
    await expect(publisher.build(request)).resolves.toEqual({ artifactId, entrypoint: 'index.html' })

    expect(register).toHaveBeenCalledTimes(2)
    expect(new Set(events)).toEqual(new Set([`stage:${artifactId}:${stagingId}`, `publish:${artifactId}:${stagingId}`]))
  })
})
