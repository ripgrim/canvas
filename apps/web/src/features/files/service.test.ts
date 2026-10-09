import { describe, expect, it } from 'vitest'
import { browserDraftKey, browserSampleAtoms } from '../../adapters/browser'
import { browserFileKey, browserFilesIndexKey, createBrowserFileService, legacyBrowserFilesKey } from './service'
import type { BrowserFileLocks, BrowserFileStorage } from './service'

type MemoryStorage = BrowserFileStorage & { contents: Map<string, string>; reads: string[]; writes: string[] }

function memoryStorage(initial: Record<string, string> = {}): MemoryStorage {
  const contents = new Map(Object.entries(initial))
  const reads: string[] = []
  const writes: string[] = []
  return {
    contents, reads, writes,
    getItem: key => { reads.push(key); return contents.get(key) ?? null },
    setItem: (key, value) => { writes.push(key); contents.set(key, value) },
  }
}

function serialLocks(): BrowserFileLocks {
  let previous: Promise<unknown> = Promise.resolve()
  return { request: <T>(_name: string, callback: () => Promise<T>) => {
    const next = previous.then(callback, callback)
    previous = next.then(() => undefined, () => undefined)
    return next
  } }
}

function sequenceIds(prefix: string) {
  let next = 0
  return () => `${prefix}-${++next}`
}

function service(storage: BrowserFileStorage, overrides: { locks?: BrowserFileLocks | null; ids?: () => string; time?: number } = {}) {
  let tick = overrides.time ?? Date.UTC(2026, 4, 1)
  const locks = overrides.locks === null ? undefined : overrides.locks ?? serialLocks()
  return createBrowserFileService({
    storage, atoms: browserSampleAtoms, legacyDraftKey: browserDraftKey, ...(locks ? { locks } : {}),
    createId: overrides.ids ?? sequenceIds('id'),
    now: () => new Date(tick += 1000),
  })
}

const frame = (name?: string) => ({ ...(name ? { name } : {}), width: 400, height: 520, direction: 'column', gap: 16, padding: 24, clip: false })

const legacyCollection = {
  version: 2,
  files: [
    {
      id: 'file-alpha', projectId: 'file-alpha', name: 'Brand kit', location: 'This browser',
      createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-03-01T00:00:00.000Z',
      activePageId: 'page-alpha-2', previewTheme: 'dark',
      pages: [
        {
          id: 'page-alpha-1', name: 'Cover',
          document: {
            version: 1, revision: 4, rootIds: ['alpha-button'],
            nodes: { 'alpha-button': { id: 'alpha-button', componentId: 'sample-button', exportName: 'Button', props: { children: 'Start' }, children: {} } },
            frame: frame('Cover'),
            tokens: { accent: '#FF0000' },
            canvas: { elements: [
              { id: 'alpha-frame', kind: 'frame', name: 'Hero', x: 10, y: 20, width: 300, height: 200, rotation: 0, fill: 'accent' },
              { id: 'alpha-rect', kind: 'rectangle', name: 'Badge', x: 4, y: 4, width: 40, height: 40, rotation: 0, fill: '#00ff00', parentId: 'alpha-frame' },
            ] },
          },
        },
        {
          id: 'page-alpha-2', name: 'Details',
          document: {
            version: 1, revision: 1, rootIds: [], nodes: {}, frame: frame('Details'),
            tokens: { accent: '#0000ff' },
            canvas: { elements: [{ id: 'alpha-rect-2', kind: 'rectangle', name: 'Swatch', x: 0, y: 0, width: 50, height: 50, rotation: 0, fill: 'accent' }] },
          },
        },
      ],
    },
    {
      id: 'file-beta', projectId: 'file-beta', name: 'Notes', location: 'This browser',
      createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z', activePageId: 'page-beta-1',
      pages: [{
        id: 'page-beta-1', name: 'Page 1',
        document: { version: 1, revision: 0, rootIds: [], nodes: {}, frame: frame(), canvas: { elements: [{ id: 'beta-text', kind: 'text', name: 'Title', x: 0, y: 0, width: 120, height: 24, rotation: 0, fill: '#111111', text: 'Hello' }] } },
      }],
    },
  ],
}

describe('browser file service', () => {
  it('creates a blank file and round trips saves with revision increments', async () => {
    const storage = memoryStorage()
    const files = service(storage)
    expect(await files.list()).toEqual([])
    const created = await files.create()
    expect(created).toEqual({ id: 'id-1', name: 'Untitled 1', location: 'This browser', updatedAt: '2026-05-01T00:00:01.000Z' })

    const opened = await files.open('id-1')
    expect(opened.name).toBe('Untitled 1')
    expect(opened.legacyView).toBeUndefined()
    expect(opened.file).toEqual({
      schemaVersion: 6, fileId: 'id-1', revision: 0,
      pages: [{ id: 'id-2', name: 'Page 1', rootNodeId: 'id-3' }],
      nodes: { 'id-3': { id: 'id-3', type: 'root' } }, relationships: {}, theme: { tokens: {} },
    })

    const edited = structuredClone(opened.file)
    edited.nodes.box = { id: 'box', type: 'rectangle', name: 'Box', styles: { left: 1, top: 2, width: 30, height: 40 }, appearance: { fills: [{ id: 'box-fill', type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: '#abcdef' } } }] } }
    edited.relationships.box = { parentId: 'id-3', orderKey: 'V' }
    const saved = await files.save('id-1', edited, 0)
    expect(saved.file.revision).toBe(1)
    const savedAgain = await files.save('id-1', saved.file, 1)
    expect(savedAgain.file.revision).toBe(2)

    const stored = JSON.parse(storage.contents.get(browserFileKey('id-1'))!)
    expect(stored.schemaVersion).toBe(1)
    // The content record keeps its own storage version; the design file inside is written at schema version 6.
    expect(stored.file.schemaVersion).toBe(6)
    expect(stored.file.nodes.box.appearance).toEqual({ fills: [{ id: 'box-fill', type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: '#abcdef' } } }] })
    expect(stored.file.revision).toBe(2)
    expect(stored.file.nodes.box.styles).toEqual({ left: 1, top: 2, width: 30, height: 40 })
    expect(JSON.parse(storage.contents.get(browserFilesIndexKey)!)).toEqual({
      schemaVersion: 1,
      files: { 'id-1': { id: 'id-1', name: 'Untitled 1', createdAt: Date.UTC(2026, 4, 1, 0, 0, 1), updatedAt: Date.UTC(2026, 4, 1, 0, 0, 3) } },
    })

    const second = await files.create()
    expect(second.name).toBe('Untitled 2')
    const reopened = service(storage)
    expect((await reopened.list()).map(file => file.name)).toEqual(['Untitled 2', 'Untitled 1'])
    expect((await reopened.open('id-1')).file.revision).toBe(2)
  })

  it('lists from the index without reading file contents', async () => {
    const storage = memoryStorage()
    const files = service(storage)
    await files.create(); await files.create()
    // A corrupt content key would fail any parse; listing must not notice it.
    storage.contents.set(browserFileKey('id-1'), '{broken')
    storage.reads.length = 0
    expect((await service(storage).list()).map(file => file.id)).toEqual(['id-4', 'id-1'])
    expect(storage.reads).toEqual([browserFilesIndexKey])
    await expect(service(storage).open('id-1')).rejects.toThrow('local file is invalid')
    expect(storage.reads).toContain(browserFileKey('id-1'))
  })

  it('rejects a stale revision and a save over another tab write', async () => {
    const storage = memoryStorage()
    const locks = serialLocks()
    const tabA = service(storage, { locks })
    await tabA.create()
    const tabB = service(storage, { locks })
    const openedA = await tabA.open('id-1')
    const openedB = await tabB.open('id-1')
    const accepted = structuredClone(openedA.file)
    accepted.pages[0]!.name = 'From A'
    await tabA.save('id-1', accepted, 0)

    const stale = structuredClone(openedB.file)
    stale.pages[0]!.name = 'From B'
    await expect(tabB.save('id-1', stale, 0)).rejects.toThrow('Document conflict: the saved revision changed')
    // Claiming the newest revision without loading it is still refused.
    await expect(tabB.save('id-1', stale, 1)).rejects.toThrow('Document conflict: the stored file changed after loading')
    expect(JSON.parse(storage.contents.get(browserFileKey('id-1'))!).file.pages[0].name).toBe('From A')

    // Negative control: after reloading, the same tab can save on top of the accepted write.
    const reloaded = await tabB.open('id-1')
    const retried = structuredClone(reloaded.file)
    retried.pages[0]!.name = 'From B'
    expect((await tabB.save('id-1', retried, 1)).file.revision).toBe(2)
  })

  it('rejects an external same-revision rewrite after opening', async () => {
    const storage = memoryStorage()
    const files = service(storage)
    await files.create()
    const opened = await files.open('id-1')
    const external = JSON.parse(storage.contents.get(browserFileKey('id-1'))!)
    external.file.pages[0].name = 'Changed elsewhere'
    storage.contents.set(browserFileKey('id-1'), JSON.stringify(external))
    await expect(files.save('id-1', opened.file, 0)).rejects.toThrow('stored file changed after loading')
    expect(JSON.parse(storage.contents.get(browserFileKey('id-1'))!).file.pages[0].name).toBe('Changed elsewhere')
  })

  it('rejects invalid files and unsafe writes without changing storage', async () => {
    const storage = memoryStorage()
    const files = service(storage)
    await files.create()
    const opened = await files.open('id-1')
    const before = new Map(storage.contents)
    const wrongFile = { ...structuredClone(opened.file), fileId: 'other' }
    await expect(files.save('id-1', wrongFile, 0)).rejects.toThrow('different local file')
    const broken = structuredClone(opened.file)
    broken.relationships.ghost = { parentId: 'id-3', orderKey: 'V' }
    await expect(files.save('id-1', broken, 0)).rejects.toThrow()
    expect(storage.contents).toEqual(before)

    const readOnly = service(storage, { locks: null })
    expect((await readOnly.list()).map(file => file.id)).toEqual(['id-1'])
    await expect(readOnly.create()).rejects.toThrow('cannot safely change local files')
    await expect(readOnly.save('id-1', (await readOnly.open('id-1')).file, 0)).rejects.toThrow('cannot safely change local files')
    expect(storage.contents).toEqual(before)
  })

  it('reports malformed and unsupported storage distinctly without writing', async () => {
    const malformedIndex = memoryStorage({ [browserFilesIndexKey]: '{broken' })
    await expect(service(malformedIndex).list()).rejects.toThrow('The local file index is invalid. Its stored contents were left unchanged.')
    await expect(service(malformedIndex).create()).rejects.toThrow('local file index is invalid')
    expect(malformedIndex.writes).toEqual([])

    const futureIndex = memoryStorage({ [browserFilesIndexKey]: JSON.stringify({ schemaVersion: 2, files: {} }) })
    await expect(service(futureIndex).list()).rejects.toThrow('unsupported format')

    const index = JSON.stringify({ schemaVersion: 1, files: { a: { id: 'a', name: 'A', createdAt: 1, updatedAt: 1 }, b: { id: 'b', name: 'B', createdAt: 1, updatedAt: 1 } } })
    const missing = memoryStorage({ [browserFilesIndexKey]: index, [browserFileKey('b')]: JSON.stringify({ schemaVersion: 7, file: {} }) })
    await expect(service(missing).open('a')).rejects.toThrow('local file contents are missing')
    await expect(service(missing).open('b')).rejects.toThrow('The local file uses an unsupported format')
    await expect(service(missing).open('c')).rejects.toThrow('The local file no longer exists')
    expect(missing.writes).toEqual([])
  })

  it('opens a stored version 2 file by upgrading it in memory and rewrites the record only on save', async () => {
    const hex = (value: string) => ({ kind: 'literal', color: { kind: 'hex', hex: value } })
    // Version 2 kept fills top-first: red is drawn above the gradient, which is above the hidden blue.
    const version2 = {
      schemaVersion: 2, fileId: 'old-file', revision: 4,
      pages: [{ id: 'old-page', name: 'Page 1', rootNodeId: 'old-root' }],
      nodes: {
        'old-root': { id: 'old-root', type: 'root' },
        panel: { id: 'panel', type: 'frame', name: 'Panel', styles: { left: 0, top: 0, width: 200, height: 100, overflow: 'clip' }, fills: [
          { type: 'solid', color: hex('#ff0000') },
          { type: 'linear-gradient', angle: 90, stops: [{ id: 'from', position: 0, color: hex('#000000') }, { id: 'to', position: 1, color: hex('#ffffff') }] },
          { type: 'solid', color: hex('#0000ff'), visible: false },
        ] },
        bare: { id: 'bare', type: 'rectangle', name: 'Bare', styles: { left: 10, top: 10, width: 20, height: 20 }, fills: [] },
      },
      relationships: { panel: { parentId: 'old-root', orderKey: 'V' }, bare: { parentId: 'old-root', orderKey: 'W' } },
      theme: { tokens: {} },
    }
    const index = JSON.stringify({ schemaVersion: 1, files: { 'old-file': { id: 'old-file', name: 'Old', createdAt: 1, updatedAt: 1 } } })
    const recordBytes = JSON.stringify({ schemaVersion: 1, file: version2 })
    const storage = memoryStorage({ [browserFilesIndexKey]: index, [browserFileKey('old-file')]: recordBytes })
    const upgradedPanel = [
      { id: 'panel:fill:3', type: 'solid', color: hex('#0000ff'), visible: false },
      { id: 'panel:fill:2', type: 'gradient', shape: 'linear', angle: 90, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'srgb', stops: [{ id: 'from', position: 0, color: hex('#000000') }, { id: 'to', position: 1, color: hex('#ffffff') }] },
      { id: 'panel:fill:1', type: 'solid', color: hex('#ff0000') },
    ]

    const files = service(storage)
    const opened = await files.open('old-file')
    expect(opened.file.schemaVersion).toBe(6)
    expect(opened.file.revision).toBe(4)
    expect(opened.file.nodes.panel).toEqual({ id: 'panel', type: 'frame', name: 'Panel', styles: { left: 0, top: 0, width: 200, height: 100, overflow: 'clip' }, appearance: { fills: upgradedPanel }, themeMode: 'inherit' })
    // An empty version 2 fill list leaves no appearance record at all.
    expect(opened.file.nodes.bare).toEqual({ id: 'bare', type: 'rectangle', name: 'Bare', styles: { left: 10, top: 10, width: 20, height: 20 }, themeMode: 'inherit' })
    // Opening never rewrites the stored record.
    expect(storage.writes).toEqual([])
    expect(storage.contents.get(browserFileKey('old-file'))).toBe(recordBytes)

    const saved = await files.save('old-file', opened.file, 4)
    expect(saved.file.revision).toBe(5)
    const stored = JSON.parse(storage.contents.get(browserFileKey('old-file'))!)
    expect(stored.schemaVersion).toBe(1)
    expect(stored.file.schemaVersion).toBe(6)
    expect(stored.file.nodes.panel).not.toHaveProperty('fills')
    expect(stored.file.nodes.panel.appearance.fills.map((paint: { id: string }) => paint.id)).toEqual(['panel:fill:3', 'panel:fill:2', 'panel:fill:1'])
    expect(stored.file.nodes.bare).not.toHaveProperty('fills')
    // Reopening the rewritten record keeps the same fill identities.
    expect((await service(storage).open('old-file')).file.nodes.panel).toMatchObject({ appearance: { fills: upgradedPanel } })

    // Negative control: a record that claims version 3 but still carries the version 2 field is refused, not upgraded.
    const mislabeled = memoryStorage({ [browserFilesIndexKey]: index, [browserFileKey('old-file')]: JSON.stringify({ schemaVersion: 1, file: { ...version2, schemaVersion: 3 } }) })
    await expect(service(mislabeled).open('old-file')).rejects.toThrow('The local file is invalid')
    expect(mislabeled.writes).toEqual([])
  })

  it('opens a stored version 3 file with component placements as version 4 layouts in a version 6 file and rewrites the record only on save', async () => {
    const version3 = {
      schemaVersion: 3, fileId: 'v3-file', revision: 2,
      pages: [{ id: 'v3-page', name: 'Page 1', rootNodeId: 'v3-root' }],
      nodes: {
        'v3-root': { id: 'v3-root', type: 'root' },
        placed: { id: 'placed', type: 'component', componentId: 'sample-button', exportName: 'Button', props: { children: 'Placed' }, layout: { mode: 'absolute', x: 14, y: 27, width: 300 } },
        sized: { id: 'sized', type: 'component', componentId: 'sample-button', exportName: 'Button', props: { children: 'Sized' }, layout: { mode: 'absolute', x: -5, y: 0, width: 120, height: 48 } },
        flowing: { id: 'flowing', type: 'component', componentId: 'sample-button', exportName: 'Button', props: { children: 'Flowing' }, layout: { mode: 'flow', x: 0, y: 0 } },
        bare: { id: 'bare', type: 'component', componentId: 'sample-button', exportName: 'Button', props: { children: 'Bare' } },
      },
      relationships: {
        placed: { parentId: 'v3-root', orderKey: 'V' },
        sized: { parentId: 'v3-root', orderKey: 'W' },
        flowing: { parentId: 'v3-root', orderKey: 'X' },
        bare: { parentId: 'v3-root', orderKey: 'Y' },
      },
      theme: { tokens: {} },
    }
    const index = JSON.stringify({ schemaVersion: 1, files: { 'v3-file': { id: 'v3-file', name: 'Three', createdAt: 1, updatedAt: 1 } } })
    const recordBytes = JSON.stringify({ schemaVersion: 1, file: version3 })
    const storage = memoryStorage({ [browserFilesIndexKey]: index, [browserFileKey('v3-file')]: recordBytes })
    const placedLayout = { item: { position: { mode: 'absolute', left: { kind: 'px', value: 14 }, top: { kind: 'px', value: 27 } }, width: { value: { kind: 'px', value: 300 } } } }
    const sizedLayout = { item: { position: { mode: 'absolute', left: { kind: 'px', value: -5 }, top: { kind: 'px', value: 0 } }, width: { value: { kind: 'px', value: 120 } }, height: { value: { kind: 'px', value: 48 } } } }
    const flowingLayout = { item: { position: { mode: 'flow' } } }

    const files = service(storage)
    const opened = await files.open('v3-file')
    expect(opened.file.schemaVersion).toBe(6)
    expect(opened.file.revision).toBe(2)
    expect(opened.file.nodes.placed).toEqual({ id: 'placed', type: 'component', componentId: 'sample-button', exportName: 'Button', props: { children: 'Placed' }, layout: placedLayout, themeMode: 'inherit' })
    expect(opened.file.nodes.sized).toMatchObject({ layout: sizedLayout })
    expect(opened.file.nodes.flowing).toMatchObject({ layout: flowingLayout })
    expect(opened.file.nodes.bare).not.toHaveProperty('layout')
    // Opening upgrades in memory only; the stored version 3 bytes stay as they were.
    expect(storage.writes).toEqual([])
    expect(storage.contents.get(browserFileKey('v3-file'))).toBe(recordBytes)

    const saved = await files.save('v3-file', opened.file, 2)
    expect(saved.file.revision).toBe(3)
    expect(storage.writes).toContain(browserFileKey('v3-file'))
    const stored = JSON.parse(storage.contents.get(browserFileKey('v3-file'))!)
    expect(stored.file.schemaVersion).toBe(6)
    expect(stored.file.nodes.placed.layout).toEqual(placedLayout)
    expect(stored.file.nodes.sized.layout).toEqual(sizedLayout)
    expect(stored.file.nodes.flowing.layout).toEqual(flowingLayout)
    expect((await service(storage).open('v3-file')).file.nodes.placed).toMatchObject({ layout: placedLayout })

    // Negative control: a record that claims version 4 but still carries a five-field placement is refused, not upgraded.
    const mislabeled = memoryStorage({ [browserFilesIndexKey]: index, [browserFileKey('v3-file')]: JSON.stringify({ schemaVersion: 1, file: { ...version3, schemaVersion: 4 } }) })
    await expect(service(mislabeled).open('v3-file')).rejects.toThrow('The local file is invalid')
    expect(mislabeled.writes).toEqual([])
  })

  it('migrates the legacy collection into an index and one key per file', async () => {
    const legacyBytes = JSON.stringify(legacyCollection)
    const storage = memoryStorage({ [legacyBrowserFilesKey]: legacyBytes })
    const files = service(storage)
    expect(await files.list()).toEqual([
      { id: 'file-alpha', name: 'Brand kit', location: 'This browser', updatedAt: '2026-03-01T00:00:00.000Z' },
      { id: 'file-beta', name: 'Notes', location: 'This browser', updatedAt: '2026-02-01T00:00:00.000Z' },
    ])
    expect(storage.contents.get(legacyBrowserFilesKey)).toBe(legacyBytes)
    expect([...storage.contents.keys()].sort()).toEqual([browserFileKey('file-alpha'), browserFileKey('file-beta'), browserFilesIndexKey, legacyBrowserFilesKey].sort())
    expect(JSON.parse(storage.contents.get(browserFilesIndexKey)!).files['file-alpha']).toEqual({ id: 'file-alpha', name: 'Brand kit', createdAt: Date.UTC(2026, 0, 2, 3, 4, 5), updatedAt: Date.UTC(2026, 2, 1) })

    const alpha = await files.open('file-alpha')
    expect(alpha.legacyView).toEqual({ activePageId: 'page-alpha-2', previewTheme: 'dark' })
    expect(alpha.file.revision).toBe(0)
    expect(alpha.file.pages).toEqual([
      { id: 'page-alpha-1', name: 'Cover', rootNodeId: 'root:page-alpha-1' },
      { id: 'page-alpha-2', name: 'Details', rootNodeId: 'root:page-alpha-2' },
    ])
    expect(Object.keys(alpha.file.nodes).sort()).toEqual(['alpha-button', 'alpha-frame', 'alpha-rect', 'alpha-rect-2', 'root:page-alpha-1', 'root:page-alpha-2'])
    expect(alpha.file.relationships['alpha-rect']?.parentId).toBe('alpha-frame')
    expect(alpha.file.relationships['alpha-button']?.parentId).toBe('root:page-alpha-1')
    expect(alpha.file.relationships['alpha-rect-2']?.parentId).toBe('root:page-alpha-2')
    expect(Object.keys(alpha.file.theme.tokens).sort()).toEqual(['legacy:accent', 'legacy:accent:page-alpha-2'])
    expect(alpha.file.theme.tokens['legacy:accent']?.value).toEqual({ kind: 'literal', color: { kind: 'hex', hex: '#ff0000' } })
    expect(alpha.file.theme.tokens['legacy:accent:page-alpha-2']?.value).toEqual({ kind: 'literal', color: { kind: 'hex', hex: '#0000ff' } })
    expect(alpha.file.schemaVersion).toBe(6)
    expect(alpha.file.nodes['alpha-frame']).toMatchObject({ appearance: { fills: [{ id: 'alpha-frame:fill:1', type: 'solid', color: { kind: 'token', tokenId: 'legacy:accent' } }] } })
    expect(alpha.file.nodes['alpha-rect']).toMatchObject({ appearance: { fills: [{ id: 'alpha-rect:fill:1', type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: '#00ff00' } } }] } })
    expect(alpha.file.nodes['alpha-frame']).not.toHaveProperty('fills')
    expect(alpha.file.nodes['alpha-rect-2']).toMatchObject({ appearance: { fills: [{ id: 'alpha-rect-2:fill:1', type: 'solid', color: { kind: 'token', tokenId: 'legacy:accent:page-alpha-2' } }] } })
    expect(alpha.file.nodes['alpha-button']).toMatchObject({ type: 'component', componentId: 'sample-button', props: { children: 'Start' } })

    const beta = await files.open('file-beta')
    expect(beta.legacyView).toEqual({ activePageId: 'page-beta-1' })
    expect(beta.file.nodes['beta-text']).toMatchObject({ type: 'text', text: 'Hello' })
    // View state stays outside the design file.
    expect(JSON.stringify(alpha.file)).not.toContain('previewTheme')

    // Saving keeps the hand-off and the legacy recovery copy.
    const saved = await files.save('file-alpha', alpha.file, 0)
    expect(saved.legacyView).toEqual({ activePageId: 'page-alpha-2', previewTheme: 'dark' })
    expect(storage.contents.get(legacyBrowserFilesKey)).toBe(legacyBytes)

    // Idempotent: once the index exists, the legacy keys are ignored even if they change.
    const changedLegacy = structuredClone(legacyCollection)
    changedLegacy.files[1]!.name = 'Renamed in old storage'
    storage.contents.set(legacyBrowserFilesKey, JSON.stringify(changedLegacy))
    storage.writes.length = 0
    const later = service(storage)
    expect((await later.list()).map(file => file.name)).toEqual(['Brand kit', 'Notes'])
    expect((await later.open('file-alpha')).file.revision).toBe(1)
    expect(storage.writes).toEqual([])
  })

  it('reads migrated files without writing when locks are unavailable', async () => {
    const legacyBytes = JSON.stringify(legacyCollection)
    const storage = memoryStorage({ [legacyBrowserFilesKey]: legacyBytes })
    const files = service(storage, { locks: null })
    expect((await files.list()).map(file => file.id)).toEqual(['file-alpha', 'file-beta'])
    expect((await files.open('file-beta')).file.pages[0]?.id).toBe('page-beta-1')
    expect(storage.writes).toEqual([])
  })

  it('migrates the oldest single draft key into the local draft file', async () => {
    const draft = {
      version: 1, revision: 3, rootIds: ['draft-label'],
      nodes: { 'draft-label': { id: 'draft-label', componentId: 'sample-label', exportName: 'Label', props: { children: 'Keep this draft' }, children: {} } },
      frame: frame(),
    }
    const draftBytes = JSON.stringify(draft)
    const storage = memoryStorage({ [browserDraftKey]: draftBytes })
    const files = service(storage)
    expect(await files.list()).toEqual([{ id: 'browser-local-sample', name: 'Local draft', location: 'This browser' }])
    const opened = await files.open('browser-local-sample')
    expect(opened.file.pages).toEqual([{ id: 'page-browser-local-sample', name: 'Page 1', rootNodeId: 'root:page-browser-local-sample' }])
    expect(opened.file.nodes['draft-label']).toMatchObject({ props: { children: 'Keep this draft' } })
    expect(opened.legacyView).toEqual({ activePageId: 'page-browser-local-sample' })
    expect(storage.contents.get(browserDraftKey)).toBe(draftBytes)
    expect(storage.contents.get(legacyBrowserFilesKey)).toBeUndefined()
  })

  it('writes nothing when any legacy record is invalid', async () => {
    const malformed = memoryStorage({ [legacyBrowserFilesKey]: '{broken' })
    await expect(service(malformed).list()).rejects.toThrow('The local file collection is invalid. Its stored contents were left unchanged.')
    expect(malformed.writes).toEqual([])

    // The first file is valid; the second has an unbound component, so the whole migration must stop.
    const partlyBad = structuredClone(legacyCollection) as { files: { pages: { document: { rootIds: string[]; nodes: Record<string, unknown> } }[] }[] }
    partlyBad.files[1]!.pages[0]!.document.rootIds = ['ghost']
    partlyBad.files[1]!.pages[0]!.document.nodes = { ghost: { id: 'ghost', componentId: 'sample-missing', exportName: 'Missing', props: {}, children: {} } }
    const bytes = JSON.stringify(partlyBad)
    const storage = memoryStorage({ [legacyBrowserFilesKey]: bytes })
    await expect(service(storage).list()).rejects.toThrow('Its stored contents were left unchanged')
    await expect(service(storage).create()).rejects.toThrow('Its stored contents were left unchanged')
    expect(storage.writes).toEqual([])
    expect([...storage.contents.keys()]).toEqual([legacyBrowserFilesKey])

    // Node identities shared across pages cannot become one file; the upgrade error names the file.
    const shared = structuredClone(legacyCollection)
    shared.files[0]!.pages[1]!.document.canvas.elements[0]!.id = 'alpha-frame'
    const sharedStorage = memoryStorage({ [legacyBrowserFilesKey]: JSON.stringify(shared) })
    await expect(service(sharedStorage).list()).rejects.toThrow('The local file "Brand kit" could not be upgraded. Its stored contents were left unchanged.')
    expect(sharedStorage.writes).toEqual([])
  })
})
