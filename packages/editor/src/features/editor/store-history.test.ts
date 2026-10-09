import { describe, expect, it, vi } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { createDocumentStore } from './document-store'
import { createEditorStore } from './store'
import type { HistoryStorage } from './document-history'
import type { DesignEditorApi, ProjectSnapshot } from './types'

const literal = (id: string, hex: string) => ({ id, type: 'solid' as const, color: { kind: 'literal' as const, color: { kind: 'hex' as const, hex } } })
function fixture(): ProjectSnapshot {
  return {
    projectId: 'history-project', fileId: 'history-file',
    atoms: [{ componentId: 'label-component', name: 'Label', exportName: 'Label', path: 'src/Label.tsx', kind: 'atom', status: 'bound', fingerprint: 'f', sourceHash: 'h', candidates: [], props: [{ name: 'children', type: 'ReactNode', optional: true }] }],
    composition: { id: 'login', name: 'Login', componentId: null, children: [{ id: 'label', componentId: 'label-component', exportName: 'Label', props: { children: 'Email' } }] },
    file: {
      schemaVersion: 5, fileId: 'history-file', revision: 0,
      pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
      nodes: {
        'root-1': { id: 'root-1', type: 'root' },
        panel: { id: 'panel', type: 'frame', name: 'Panel', styles: { left: 0, top: 0, width: 400, height: 520, overflow: 'clip' }, appearance: { fills: [literal('panel-fill', '#ffffff')] } },
        label: { id: 'label', type: 'component', componentId: 'label-component', exportName: 'Label', props: { children: 'Email' } },
      },
      relationships: { panel: { parentId: 'root-1', orderKey: 'V' }, label: { parentId: 'root-1', orderKey: 'W' } },
      theme: { tokens: {} },
    },
    sourceHashes: { 'src/Label.tsx': 'h' }, sourceHistory: [], conflict: null, phases: [], tokens: [],
    preview: { status: 'stopped', currentGeneration: 0, activeGeneration: null, origin: null, url: null, stale: false, diagnostics: [] },
  }
}
const cacheKey = 'design-editor:document-history:v2:history-file'

function memory() {
  const values = new Map<string, string>()
  const api: HistoryStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } }
  return { values, api }
}

/** Disk adapter with stale-revision protection: a save must name the stored revision. */
function boundary() {
  let acknowledged = fixture()
  const revisions: number[] = []
  const unavailable = async (): Promise<never> => { throw new Error('A document history test must not prepare or write source') }
  const accept = (file: FileDocument, expectedRevision: number) => {
    if (expectedRevision !== acknowledged.file.revision) throw new Error('Document revision conflict')
    acknowledged = { ...acknowledged, file: { ...structuredClone(file), revision: expectedRevision + 1 } }
    return structuredClone(acknowledged)
  }
  const api: DesignEditorApi = {
    openProject: async () => structuredClone(acknowledged), refresh: async () => structuredClone(acknowledged),
    saveFile: async (file, revision) => { revisions.push(revision); return accept(file, revision) },
    prepareLabelPadding: unavailable, prepareToken: unavailable, preparePromotion: unavailable,
    prepareUndo: unavailable, prepareRedo: unavailable, savePrepared: unavailable,
  }
  return { api, revisions, accept, snapshot: () => structuredClone(acknowledged), replace: (snapshot: ProjectSnapshot) => { acknowledged = structuredClone(snapshot) } }
}

async function open(api: DesignEditorApi, storage: HistoryStorage, persist = true) {
  const documents = createDocumentStore()
  const editor = createEditorStore(() => api, documents, () => storage)
  if (persist) documents.configure({ persist: editor.persistFile, onChange: editor.documentChanged })
  await editor.open()
  expect(editor.getSnapshot().error).toBeNull()
  return { documents, editor, close: () => { documents.dispose(); editor.dispose() } }
}

async function settled(documents: ReturnType<typeof createDocumentStore>) {
  await vi.waitFor(() => expect(documents.getSnapshot().saving).toBe(false))
  expect(documents.getSnapshot().error).toBeNull()
}
const panelWidth = (documents: ReturnType<typeof createDocumentStore>) => (documents.getSnapshot().file!.nodes.panel as { styles: { width: number } }).styles.width
const labelText = (documents: ReturnType<typeof createDocumentStore>) => (documents.getSnapshot().file!.nodes.label as unknown as { props: { children: string } }).props.children

describe('AT-CAN persistent history through real editor and document stores', () => {
  it('reopens undo and redo with exact prior values, selections, and acknowledged revisions', async () => {
    const disk = boundary()
    const cache = memory()
    const first = await open(disk.api, cache.api)
    first.documents.select('label')
    expect(first.documents.commands.setProps('label', { children: 'Username' })).toBe(true)
    await settled(first.documents)
    first.documents.select('panel')
    expect(first.documents.commands.setStyles('panel', { width: 640 })).toBe(true)
    await settled(first.documents)
    expect(disk.snapshot().file.revision).toBe(2)
    const cached = JSON.parse(cache.values.get(cacheKey)!)
    expect(cached.version).toBe(2)
    expect(cached.currentFile.revision).toBe(2)
    expect(cached.history.past).toHaveLength(2)
    first.close()

    const second = await open(disk.api, cache.api)
    expect(second.documents.getSnapshot().selection).toEqual([])
    expect(second.documents.getSnapshot().canUndo).toBe(true)
    expect(panelWidth(second.documents)).toBe(640)
    expect(second.documents.undo()).toBe(true)
    await settled(second.documents)
    expect(panelWidth(second.documents)).toBe(400)
    expect(labelText(second.documents)).toBe('Username')
    expect(second.documents.getSnapshot().selection).toEqual(['panel'])
    expect(second.documents.getSnapshot().file!.revision).toBe(3)
    second.close()

    const third = await open(disk.api, cache.api)
    expect(third.documents.getSnapshot().canRedo).toBe(true)
    expect(third.documents.redo()).toBe(true)
    await settled(third.documents)
    expect(panelWidth(third.documents)).toBe(640)
    expect(labelText(third.documents)).toBe('Username')
    expect(third.documents.getSnapshot().file!.revision).toBe(4)
    expect(third.documents.undo()).toBe(true)
    await settled(third.documents)
    expect(third.documents.undo()).toBe(true)
    await settled(third.documents)
    expect(labelText(third.documents)).toBe('Email')
    expect(panelWidth(third.documents)).toBe(400)
    expect(third.documents.getSnapshot().selection).toEqual(['label'])
    expect(third.documents.getSnapshot().canUndo).toBe(false)
    expect(disk.revisions).toEqual([0, 1, 2, 3, 4, 5])
    third.close()
  })

  it('pairs captured history with each acknowledgement while newer commands wait in flight', async () => {
    const disk = boundary()
    const cache = memory()
    const pending: { file: FileDocument; revision: number; resolve: (snapshot: ProjectSnapshot) => void }[] = []
    const delayedApi: DesignEditorApi = { ...disk.api, saveFile: (file, revision) => new Promise(resolve => pending.push({ file: structuredClone(file), revision, resolve })) }
    const active = await open(delayedApi, cache.api)
    active.documents.commands.setProps('label', { children: 'Username' })
    active.documents.commands.setStyles('panel', { width: 640 })
    expect(pending).toHaveLength(1)
    expect((pending[0]!.file.nodes.panel as { styles: { width: number } }).styles.width).toBe(400)
    expect(panelWidth(active.documents)).toBe(640)
    pending[0]!.resolve(disk.accept(pending[0]!.file, pending[0]!.revision))
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    const firstCache = JSON.parse(cache.values.get(cacheKey)!)
    expect(firstCache.currentFile.revision).toBe(1)
    expect(firstCache.currentFile.nodes.panel.styles.width).toBe(400)
    expect(firstCache.history.past).toHaveLength(1)
    expect(firstCache.history.past[0].file.nodes.label.props.children).toBe('Email')
    const interruptedReopen = await open(disk.api, cache.api, false)
    expect(interruptedReopen.documents.undo()).toBe(true)
    expect(labelText(interruptedReopen.documents)).toBe('Email')
    expect(panelWidth(interruptedReopen.documents)).toBe(400)
    interruptedReopen.close()

    expect(pending[1]!.revision).toBe(1)
    pending[1]!.resolve(disk.accept(pending[1]!.file, pending[1]!.revision))
    await settled(active.documents)
    const secondCache = JSON.parse(cache.values.get(cacheKey)!)
    expect(secondCache.currentFile.nodes.panel.styles.width).toBe(640)
    expect(secondCache.currentFile.revision).toBe(2)
    expect(secondCache.history.past).toHaveLength(2)
    expect(secondCache.history.past[1].file.nodes.label.props.children).toBe('Username')
    expect(secondCache.history.past[1].file.nodes.panel.styles.width).toBe(400)
    active.close()
    const reopened = await open(disk.api, cache.api, false)
    expect(reopened.documents.undo()).toBe(true)
    expect(panelWidth(reopened.documents)).toBe(400)
    expect(labelText(reopened.documents)).toBe('Username')
    reopened.close()
  })

  it('reports quota failure while keeping the acknowledged revision, later edits, and session undo', async () => {
    const disk = boundary()
    const cache = memory()
    const unavailable: HistoryStorage = { ...cache.api, setItem: () => { throw new Error('Quota exceeded') } }
    const active = await open(disk.api, unavailable)
    active.documents.commands.setStyles('panel', { width: 640 })
    await settled(active.documents)
    expect(active.documents.getSnapshot().file!.revision).toBe(1)
    expect(active.documents.getSnapshot().dirty).toBe(false)
    expect(active.documents.getSnapshot().blocked).toBe(false)
    expect(active.editor.getSnapshot().error).toBe('Document saved, but undo history could not be saved. Keep this window open to undo these edits.')
    expect(active.documents.commands.setProps('label', { children: 'Username' })).toBe(true)
    await settled(active.documents)
    expect(active.documents.getSnapshot().file!.revision).toBe(2)
    expect(active.documents.undo()).toBe(true)
    await settled(active.documents)
    expect(labelText(active.documents)).toBe('Email')
    expect(panelWidth(active.documents)).toBe(640)
    expect(disk.revisions).toEqual([0, 1, 2])
    expect(cache.values.size).toBe(0)
    active.close()
  })

  it('drops stale undo after same-revision external content changes', async () => {
    const disk = boundary()
    const cache = memory()
    const first = await open(disk.api, cache.api)
    first.documents.commands.setStyles('panel', { width: 640 })
    await settled(first.documents)
    first.close()
    expect(cache.values.has(cacheKey)).toBe(true)
    const external = disk.snapshot()
    ;(external.file.nodes.panel as { styles: { width: number } }).styles.width = 720
    disk.replace(external)
    const reopened = await open(disk.api, cache.api)
    expect(reopened.documents.getSnapshot().file!.revision).toBe(1)
    expect(panelWidth(reopened.documents)).toBe(720)
    expect(reopened.documents.getSnapshot().canUndo).toBe(false)
    expect(reopened.documents.undo()).toBe(false)
    expect(cache.values.has(cacheKey)).toBe(false)
    expect(reopened.documents.commands.setStyles('panel', { width: 800 })).toBe(true)
    await settled(reopened.documents)
    expect(reopened.documents.undo()).toBe(true)
    await settled(reopened.documents)
    expect(panelWidth(reopened.documents)).toBe(720)
    reopened.close()
  })

  it('drops malformed cached history without blocking the loaded document', async () => {
    const disk = boundary()
    const cache = memory()
    const first = await open(disk.api, cache.api)
    first.documents.commands.setStyles('panel', { width: 640 })
    await settled(first.documents)
    first.close()
    const payload = JSON.parse(cache.values.get(cacheKey)!)
    payload.history.past[0].file.nodes.label.componentId = 'deleted-component'
    cache.values.set(cacheKey, JSON.stringify(payload))
    const reopened = await open(disk.api, cache.api)
    expect(panelWidth(reopened.documents)).toBe(640)
    expect(reopened.documents.getSnapshot().canUndo).toBe(false)
    expect(reopened.documents.getSnapshot().blocked).toBe(false)
    expect(cache.values.has(cacheKey)).toBe(false)
    expect(reopened.documents.commands.setProps('label', { children: 'Username' })).toBe(true)
    await settled(reopened.documents)
    expect(reopened.documents.getSnapshot().canUndo).toBe(true)
    reopened.close()
  })
})
