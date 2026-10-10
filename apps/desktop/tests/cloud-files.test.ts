import { describe, expect, it } from 'vitest'
import { createBlankFile } from '@canvas/repo-engine/file-document'
import { DesktopCloudFiles } from '../src/main/cloud-files'

const id = '11111111-2222-4333-8444-555555555555'
const metadata = { id, projectId: null, name: 'Untitled 1', headRevision: 0, thumbnailKey: null, createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' }
const document = createBlankFile(id, 'page_cloud', 'root_cloud', 'Page 1')
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

describe('desktop cloud files', () => {
  it('uses the main-process authenticated request boundary for cloud files', async () => {
    const paths: string[] = []
    const request = async (path: string, init?: RequestInit) => {
      paths.push(`${init?.method ?? 'GET'} ${new URL(path).pathname}`)
      if (path.endsWith('/api/files') && init?.method === 'POST') return json({ file: metadata }, 201)
      if (path.endsWith('/api/files')) return json({ files: [metadata] })
      if (path.endsWith('/document') && init?.method === 'PUT') return json({ fileId: id, revision: 1, document: { ...document, revision: 1 } })
      if (path.endsWith('/document')) return json({ fileId: id, revision: 0, document })
      return json({ file: metadata })
    }
    const service = new DesktopCloudFiles({ request }, 'https://api.canvas.test', 'https://app.canvas.test', 'https://preview.canvas.test')
    expect(await service.list()).toHaveLength(1)
    expect((await service.create()).id).toBe(id)
    expect((await service.open(id)).file).toEqual(document)
    expect((await service.save(document, 0)).file.revision).toBe(1)
    expect(paths).toContain('PUT /api/files/11111111-2222-4333-8444-555555555555/document')
  })
})
