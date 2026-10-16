import { describe, expect, it, vi } from 'vitest'
import { createDocument } from '@canvas/repo-engine/document'
import { isRepositoryAtom } from '@canvas/repo-engine/contracts'
import { UnavailableCapabilityError } from '@canvas/editor/capabilities'
import { browserDraftKey, browserHollowAtoms, browserSampleComposition, browserSampleThemes, createBrowserAdapter } from './browser'
import { browserFileKey, browserFilesIndexKey, migratedBrowserFileId } from '../features/files/service'
import type { BrowserDraftLocks, BrowserDraftStorage } from './browser'

function memoryStorage(initial: Record<string, string> = {}): BrowserDraftStorage & { contents: Map<string, string> } {
  const contents = new Map(Object.entries(initial))
  return {
    contents,
    getItem: key => contents.get(key) ?? null,
    setItem: (key, value) => { contents.set(key, value) },
  }
}

function serialLocks(): BrowserDraftLocks {
  let previous: Promise<unknown> = Promise.resolve()
  return { request: <T>(_name: string, callback: () => Promise<T>) => {
    const next = previous.then(callback, callback)
    previous = next.then(() => undefined, () => undefined)
    return next
  } }
}

/** The single draft the oldest browser build stored: the bundled login composition with one edited label. */
function legacyDraft(buttonText: string) {
  const document = createDocument(browserHollowAtoms, browserSampleComposition)
  document.nodes['sample-instance-button']!.props.children = buttonText
  return JSON.stringify({ ...document, revision: 2 })
}

describe('browser local files', () => {
  it('creates, lists, opens and saves blank local files', async () => {
    const storage = memoryStorage()
    const first = createBrowserAdapter(storage, undefined, undefined, serialLocks())
    expect(await first.listFiles?.()).toEqual([])
    const created = await first.createFile?.()
    expect(created).toMatchObject({ name: 'Untitled 1', location: 'This browser' })

    const opened = await first.openFile(created!.id)
    expect(opened).toMatchObject({ projectId: created!.id, fileId: created!.id, composition: { name: 'Untitled 1', children: [] } })
    expect(opened.legacyView).toBeUndefined()
    expect(opened.file.pages).toHaveLength(1)
    expect(Object.values(opened.file.nodes)).toEqual([{ id: opened.file.pages[0]!.rootNodeId, type: 'root' }])
    expect(opened.file.theme.tokens).toEqual({})
    expect(opened.file.revision).toBe(0)
    expect(opened.file.schemaVersion).toBe(13)

    const changed = structuredClone(opened.file)
    changed.pages[0]!.name = 'First page'
    const saved = await first.saveFile(changed, 0)
    expect(saved.file.revision).toBe(1)
    expect((await first.refresh()).file.pages[0]?.name).toBe('First page')

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 60_000)
    const second = await first.createFile?.().finally(() => vi.useRealTimers())
    expect(second?.name).toBe('Untitled 2')
    const reopened = createBrowserAdapter(storage, undefined, undefined, serialLocks())
    expect((await reopened.listFiles?.())?.map(file => file.name)).toEqual(['Untitled 2', 'Untitled 1'])
    const firstReopened = await reopened.openFile(created!.id)
    expect(firstReopened.file.pages[0]?.name).toBe('First page')
    expect(firstReopened.file.revision).toBe(1)
    expect(storage.getItem(browserDraftKey)).toBeNull()
    expect(storage.getItem(browserFilesIndexKey)).not.toBeNull()
    expect(storage.getItem(browserFileKey(created!.id))).not.toBeNull()
    expect(JSON.parse(storage.getItem(browserFileKey(created!.id))!)).toMatchObject({ schemaVersion: 1, file: { schemaVersion: 13, revision: 1 } })
  })

  it('opens the migrated draft first, otherwise the most recent file, and asks for a file when none exist', async () => {
    const empty = createBrowserAdapter(memoryStorage(), undefined, undefined, serialLocks())
    await expect(empty.openProject()).rejects.toBeInstanceOf(UnavailableCapabilityError)
    await expect(empty.openProject()).rejects.toThrow('Create a local file first')

    const storage = memoryStorage()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const adapter = createBrowserAdapter(storage, undefined, undefined, serialLocks())
      vi.setSystemTime(Date.UTC(2026, 0, 1))
      await adapter.createFile?.()
      vi.setSystemTime(Date.UTC(2026, 0, 2))
      const newer = await adapter.createFile?.()
      expect((await adapter.openProject()).fileId).toBe(newer!.id)
    } finally { vi.useRealTimers() }

    const withDraft = memoryStorage({ [browserDraftKey]: legacyDraft('Keep this draft') })
    const adapter = createBrowserAdapter(withDraft, undefined, undefined, serialLocks())
    await adapter.createFile?.()
    expect((await adapter.openProject()).fileId).toBe(migratedBrowserFileId)
  })

  it('migrates the single legacy draft without changing its bytes and hands over its view state', async () => {
    const bytes = legacyDraft('Keep this draft')
    const storage = memoryStorage({ [browserDraftKey]: bytes })
    const adapter = createBrowserAdapter(storage, 'http://127.0.0.1:4318', 'http://127.0.0.1:4317', serialLocks())
    expect(await adapter.listFiles?.()).toEqual([{ id: migratedBrowserFileId, name: 'Local draft', location: 'This browser' }])
    const opened = await adapter.openProject()
    expect(opened.fileId).toBe(migratedBrowserFileId)
    expect(opened.composition.name).toBe('Local draft')
    expect(opened.composition.children).toHaveLength(5)
    expect(opened.file.pages.map(page => page.id)).toEqual(['page-browser-local-sample'])
    expect(opened.file.nodes['sample-instance-button']).toMatchObject({ type: 'component', props: { children: 'Keep this draft' } })
    expect(opened.legacyView).toEqual({ activePageId: 'page-browser-local-sample' })
    expect(opened.preview.url).toBe('http://127.0.0.1:4318/?generation=1&editorOrigin=http%3A%2F%2F127.0.0.1%3A4317&file=browser-local-sample')
    expect(storage.getItem(browserDraftKey)).toBe(bytes)
  })

  it('exposes the bundled atoms, source tokens and design themes without claiming repository access', async () => {
    const adapter = createBrowserAdapter(memoryStorage(), undefined, undefined, serialLocks())
    const created = await adapter.createFile?.()
    const opened = await adapter.openFile(created!.id)
    expect(opened.atoms.map(atom => atom.componentId)).toEqual(['sample-button', 'sample-card', 'sample-input', 'sample-label'])
    expect(opened.atoms.every(atom => isRepositoryAtom(atom) && atom.path.startsWith('Bundled sample / '))).toBe(true)
    expect(opened.phases).toEqual([{ name: 'Hollow browser catalog loaded', completed: 1 }])
    // Vitest stubs CSS imports, so the seed stylesheet catalog is empty here; the snapshot still carries the module's catalog and themes.
    expect(opened.tokens).toEqual([])
    expect(opened.designThemes).toEqual(browserSampleThemes)
    expect(opened.preview).toMatchObject({ status: 'stopped', url: null, activeGeneration: null })
    expect(adapter.capabilities?.sourceWrites).toMatchObject({ available: false, reason: 'Source editing needs a connected repository. This draft stays in this browser.' })
    expect(adapter.capabilities?.hostedProjects.available).toBe(false)
  })

  it('previews a file without components in composition mode', async () => {
    const adapter = createBrowserAdapter(memoryStorage(), 'http://127.0.0.1:4318', 'http://127.0.0.1:4317', serialLocks())
    const created = await adapter.createFile?.()
    const opened = await adapter.openFile(created!.id)
    expect(opened.preview.url).toBe(`http://127.0.0.1:4318/?generation=1&editorOrigin=http%3A%2F%2F127.0.0.1%3A4317&file=${created!.id}&mode=composition`)
    expect(opened.preview.origin).toBe('http://127.0.0.1:4318')
  })

  it('rejects a stale save from another tab and keeps the first saved content', async () => {
    const storage = memoryStorage()
    const locks = serialLocks()
    const first = createBrowserAdapter(storage, undefined, undefined, locks)
    const created = await first.createFile?.()
    const second = createBrowserAdapter(storage, undefined, undefined, locks)
    const openedA = await first.openFile(created!.id)
    const openedB = await second.openFile(created!.id)
    const accepted = structuredClone(openedA.file)
    accepted.pages[0]!.name = 'First save'
    const stale = structuredClone(openedB.file)
    stale.pages[0]!.name = 'Stale overwrite'
    const results = await Promise.allSettled([first.saveFile(accepted, 0), second.saveFile(stale, 0)])
    expect(results[0].status).toBe('fulfilled')
    expect(results[1].status).toBe('rejected')
    if (results[1].status === 'rejected') expect(String(results[1].reason)).toContain('Document conflict')
    expect(JSON.parse(storage.getItem(browserFileKey(created!.id))!).file.pages[0].name).toBe('First save')
  })

  it('rejects unsafe props and saving without an open file, leaving storage unchanged', async () => {
    const storage = memoryStorage({ [browserDraftKey]: legacyDraft('Original') })
    const adapter = createBrowserAdapter(storage, undefined, undefined, serialLocks())
    const opened = await adapter.openProject()
    const before = new Map(storage.contents)
    const invalid = structuredClone(opened.file)
    const button = invalid.nodes['sample-instance-button']!
    if (button.type !== 'component') throw new Error('Expected the sample button instance')
    button.props.onClick = 'alert(1)'
    await expect(adapter.saveFile(invalid, 0)).rejects.toThrow('Unsupported prop onClick')
    expect(storage.contents).toEqual(before)
    await expect(createBrowserAdapter(storage, undefined, undefined, serialLocks()).saveFile(opened.file, 0)).rejects.toThrow('Open a local file before saving it')
  })

  it('rejects every source write, invalid preview origins, and writes without locks', async () => {
    const adapter = createBrowserAdapter(memoryStorage())
    const calls = [
      adapter.prepareLabelPadding('8px'), adapter.prepareToken('#009ff0'), adapter.preparePromotion('Login'),
      adapter.prepareUndo('old'), adapter.prepareRedo('old'), adapter.savePrepared('id', 'digest'),
    ]
    for (const call of calls) await expect(call).rejects.toBeInstanceOf(UnavailableCapabilityError)
    expect(() => createBrowserAdapter(memoryStorage(), 'http://example.com:4318', 'http://127.0.0.1:4317')).toThrow('must use HTTPS outside loopback')
    expect(() => createBrowserAdapter(memoryStorage(), 'http://127.0.0.1:4318/path', 'http://127.0.0.1:4317')).toThrow('must be an HTTP or HTTPS origin')
    expect(() => createBrowserAdapter(memoryStorage(), 'http://127.0.0.1:4317', 'http://127.0.0.1:4317')).toThrow('separate origin')

    const storage = memoryStorage()
    const created = await createBrowserAdapter(storage, undefined, undefined, serialLocks()).createFile?.()
    const noLocks = createBrowserAdapter(storage)
    expect(noLocks.capabilities?.files.create).toMatchObject({ available: false })
    const opened = await noLocks.openProject()
    expect(opened.fileId).toBe(created!.id)
    const before = new Map(storage.contents)
    await expect(noLocks.saveFile(opened.file, 0)).rejects.toThrow('cannot safely save concurrent edits')
    await expect(noLocks.createFile?.()).rejects.toThrow('cannot safely change local files')
    expect(storage.contents).toEqual(before)
  })
})
