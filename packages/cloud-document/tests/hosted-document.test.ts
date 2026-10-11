import { describe, expect, it } from 'vitest'
import { externalizeHostedFileDocument, validateHostedFileDocument } from '../src/index.js'

const blank = () => ({
  schemaVersion: 7,
  fileId: 'file-1',
  revision: 0,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: { 'root-1': { id: 'root-1', type: 'root' } },
  relationships: {},
  theme: { tokens: {} },
})

describe('hosted document validation', () => {
  it('accepts a canonical blank document', () => {
    expect(validateHostedFileDocument(blank())).toEqual(blank())
  })

  it('upgrades an asset-free version 6 document and rejects inline asset migration', () => {
    expect(validateHostedFileDocument({ ...blank(), schemaVersion: 6 })).toEqual(blank())
    expect(() => validateHostedFileDocument({ ...blank(), schemaVersion: 6, assets: { photo: { data: 'inline' } } })).toThrow('externalization')
  })

  it('checks the complete primitive graph instead of only the envelope', () => {
    const input = blank()
    ;(input.nodes as Record<string, unknown>).box = { id: 'box', type: 'rectangle', name: 'Box', styles: { left: 0, top: 0, width: -1, height: 10 } }
    ;(input.relationships as Record<string, unknown>).box = { parentId: 'root-1', orderKey: 'a0' }
    expect(() => validateHostedFileDocument(input)).toThrow('Invalid node geometry')
  })

  it('allows unavailable hosted component bindings but rejects unsafe props', () => {
    const input = blank()
    ;(input.nodes as Record<string, unknown>).button = { id: 'button', type: 'component', componentId: 'button-component', exportName: 'Button', props: { children: 'Save' } }
    ;(input.relationships as Record<string, unknown>).button = { parentId: 'root-1', orderKey: 'V' }
    expect(validateHostedFileDocument(input).nodes.button).toMatchObject({ componentId: 'button-component', props: { children: 'Save' } })
    ;((input.nodes as Record<string, Record<string, unknown>>).button!.props as Record<string, unknown>).onClick = 'alert(1)'
    expect(() => validateHostedFileDocument(input)).toThrow('Unsupported prop onClick')
  })

  it('validates hosted Card slot relationships without claiming a source binding', () => {
    const input = blank()
    ;(input.nodes as Record<string, unknown>).card = { id: 'card', type: 'component', componentId: 'card-component', exportName: 'Card', props: {} }
    ;(input.nodes as Record<string, unknown>).button = { id: 'button', type: 'component', componentId: 'button-component', exportName: 'Button', props: { children: 'Save' } }
    ;(input.relationships as Record<string, unknown>).card = { parentId: 'root-1', orderKey: 'V' }
    ;(input.relationships as Record<string, unknown>).button = { parentId: 'card', orderKey: 'V', slot: 'footer' }
    expect(validateHostedFileDocument(input).relationships.button).toEqual({ parentId: 'card', orderKey: 'V', slot: 'footer' })
  })

  it('rejects one component identity bound to different exports', () => {
    const input = blank()
    ;(input.nodes as Record<string, unknown>).one = { id: 'one', type: 'component', componentId: 'shared', exportName: 'Button', props: {} }
    ;(input.nodes as Record<string, unknown>).two = { id: 'two', type: 'component', componentId: 'shared', exportName: 'Input', props: {} }
    ;(input.relationships as Record<string, unknown>).one = { parentId: 'root-1', orderKey: 'a0' }
    ;(input.relationships as Record<string, unknown>).two = { parentId: 'root-1', orderKey: 'a1' }
    expect(() => validateHostedFileDocument(input)).toThrow('Component identity is inconsistent')
  })

  it('FILE-ASSET-001 externalizes every validated version 6 image before returning schema 7', async () => {
    const source = {
      ...blank(),
      schemaVersion: 6,
      assets: {
        photo: { id: 'photo', name: 'photo.jpg', mime: 'image/jpeg', width: 1, height: 1, bytes: 3, data: 'AAAA' },
      },
    }
    const uploads: unknown[] = []
    const result = await externalizeHostedFileDocument(source, async input => {
      uploads.push(input)
      return { id: 'photo', name: 'photo.jpg', mime: 'image/jpeg', extension: 'jpg', width: 1, height: 1, bytes: 3, sha256: 'a'.repeat(64) }
    })

    expect(result.status).toBe('externalized')
    if (result.status !== 'externalized') throw new Error('Expected externalization')
    expect(uploads).toEqual([{ fileId: 'file-1', asset: { id: 'photo', name: 'photo.jpg', mime: 'image/jpeg', extension: 'jpg', width: 1, height: 1, bytes: 3, data: 'AAAA' } }])
    expect(result.document).toEqual({
      ...blank(),
      assets: { photo: { id: 'photo', name: 'photo.jpg', mime: 'image/jpeg', extension: 'jpg', width: 1, height: 1, bytes: 3, sha256: 'a'.repeat(64) } },
    })
    expect(source).toHaveProperty('assets.photo.data', 'AAAA')
  })

  it('FILE-ASSET-SEC-001 validates the full graph before uploading legacy bytes', async () => {
    const source = {
      ...blank(),
      schemaVersion: 6,
      assets: {
        photo: { id: 'photo', name: 'photo.png', mime: 'image/png', width: 1, height: 1, bytes: 3, data: 'AAAA' },
      },
      relationships: { ghost: { parentId: 'missing', orderKey: 'V' } },
    }
    let uploads = 0
    await expect(externalizeHostedFileDocument(source, async () => {
      uploads += 1
      throw new Error('must not upload')
    })).rejects.toThrow()
    expect(uploads).toBe(0)
  })

  it('FILE-ASSET-SEC-001 rejects malformed bytes and mismatched trusted results', async () => {
    const source = {
      ...blank(),
      schemaVersion: 6,
      assets: {
        photo: { id: 'photo', name: 'photo.png', mime: 'image/png', width: 1, height: 1, bytes: 4, data: 'AAAA' },
      },
    }
    await expect(externalizeHostedFileDocument(source, async () => {
      throw new Error('must not upload')
    })).rejects.toThrow('size does not match')

    const valid = { ...source, assets: { photo: { ...source.assets.photo, bytes: 3 } } }
    await expect(externalizeHostedFileDocument(valid, async () => ({
      id: 'other', name: 'photo.png', mime: 'image/png', extension: 'png', width: 1, height: 1, bytes: 3, sha256: 'a'.repeat(64),
    }))).rejects.toThrow('metadata does not match')

    await expect(externalizeHostedFileDocument({ ...valid, assets: { 'photo:unsafe': { ...valid.assets.photo, id: 'photo:unsafe' } } }, async () => {
      throw new Error('must not upload')
    })).rejects.toThrow('identity')
  })

  it('does not call the migration uploader for a current document', async () => {
    let uploads = 0
    const result = await externalizeHostedFileDocument(blank(), async () => {
      uploads += 1
      throw new Error('must not upload')
    })
    expect(result).toEqual({ status: 'current', document: blank() })
    expect(uploads).toBe(0)
  })
})
