import { describe, expect, it } from 'vitest'
import { createBlankFile } from '@canvas/repo-engine/file-document'
import type { Atom } from '@canvas/repo-engine'
import type { PreviewSnapshot } from '@canvas/preview-runtime'
import { shadcnPreviewComponentId } from '@canvas/scanner/preview-registry'
import { DesktopCloudFiles } from '../src/main/cloud-files'

const id = '11111111-2222-4333-8444-555555555555'
const metadata = { id, projectId: null, name: 'Untitled 1', headRevision: 0, thumbnailKey: null, createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' }
const document = createBlankFile(id, 'page_cloud', 'root_cloud', 'Page 1')
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

describe('desktop cloud files', () => {
  it('carries only the registered bundled editor origin into the cloud preview URL', async () => {
    const service = new DesktopCloudFiles({ request: async path => path.endsWith('/document') ? json({ fileId: id, revision: 0, document }) : json({ file: metadata }) }, 'https://api.canvas.test', 'design-editor://app', 'https://preview.canvas.test')
    const opened = await service.open(id)
    expect(new URL(opened.preview.url!).searchParams.get('editorOrigin')).toBe('design-editor://app')
    expect(service.activePreviewUrl()).toBe(opened.preview.url)
    expect(() => new DesktopCloudFiles({ request: async () => json({}) }, 'https://api.canvas.test', 'other-editor://app')).toThrow('Editor origin must be an HTTP or HTTPS origin.')
  })

  it('uses the main-process authenticated request boundary for cloud files', async () => {
    const paths: string[] = []
    const writes: unknown[] = []
    const request = async (path: string, init?: RequestInit) => {
      paths.push(`${init?.method ?? 'GET'} ${new URL(path).pathname}`)
      if (path.endsWith('/api/files') && init?.method === 'POST') return json({ file: metadata }, 201)
      if (path.endsWith('/api/files')) return json({ files: [metadata] })
      if (path.endsWith('/document') && init?.method === 'PUT') { writes.push(JSON.parse(String(init.body))); return json({ fileId: id, revision: 1, document: { ...document, revision: 1 } }) }
      if (path.endsWith('/document')) return json({ fileId: id, revision: 0, document })
      return json({ file: metadata })
    }
    const service = new DesktopCloudFiles({ request }, 'https://api.canvas.test', 'https://app.canvas.test', 'https://preview.canvas.test')
    expect(await service.list()).toHaveLength(1)
    expect((await service.create()).id).toBe(id)
    expect((await service.open(id)).file).toEqual(document)
    expect((await service.save({ ...document, revision: 1 }, 0)).file.revision).toBe(1)
    expect(paths).toContain('PUT /api/files/11111111-2222-4333-8444-555555555555/document')
    expect(writes).toEqual([{ expectedRevision: 0, document }])
  })

  it('uses the stable private thumbnail resolver for cloud file summaries', async () => {
    const thumbnailMetadata = { ...metadata, thumbnailKey: `thumbnails/${id}/versions/0/nonce.avif` }
    const service = new DesktopCloudFiles(
      { request: async () => json({ files: [thumbnailMetadata] }) },
      'https://api.canvas.test',
      'https://app.canvas.test',
      'https://preview.canvas.test',
      'https://assets.canvas.test',
    )

    expect((await service.list())[0]?.thumbnailUrl).toBe(`https://assets.canvas.test/file-assets/thumbnails/${id}/thumbnail.avif`)
  })

  it('validates and projects cloud documents against the active verified repository catalog', async () => {
    const componentId = shadcnPreviewComponentId({ path: 'src/components/ui/login-form.tsx', exportName: 'LoginForm' })
    const loginForm: Atom = {
      componentId,
      name: 'LoginForm',
      exportName: 'LoginForm',
      path: 'src/components/ui/login-form.tsx',
      fingerprint: 'verified-fingerprint',
      sourceHash: 'source-hash',
      status: 'bound',
      candidates: [],
      kind: 'atom',
      props: [],
      slots: [],
    }
    const connectedDocument = structuredClone(document)
    connectedDocument.nodes.login = { id: 'login', type: 'component', componentId, exportName: 'LoginForm', props: {} }
    connectedDocument.relationships.login = { parentId: 'root_cloud', orderKey: 'V' }
    const projected: string[] = []
    const preview: PreviewSnapshot = {
      status: 'ready', currentGeneration: 3, activeGeneration: 3, origin: 'http://127.0.0.1:49152',
      url: 'http://127.0.0.1:49152/connected/3/build/3/index.html', stale: false, diagnostics: [],
    }
    const service = new DesktopCloudFiles(
      { request: async path => path.endsWith('/document') ? json({ fileId: id, revision: 0, document: connectedDocument }) : json({ file: metadata }) },
      'https://api.canvas.test',
      'design-editor://app',
      undefined,
      undefined,
      { atoms: () => [loginForm], project: async file => { projected.push(file.fileId); return preview } },
    )

    const opened = await service.open(id)
    expect(opened.atoms).toEqual([loginForm])
    expect(opened.preview).toEqual(preview)
    expect(opened.phases).toEqual([{ name: 'Verified repository catalog loaded', completed: 1 }])
    expect(projected).toEqual([id])
  })
})
