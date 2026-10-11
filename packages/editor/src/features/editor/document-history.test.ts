import { describe, expect, it } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { Atom } from './types'
import { documentHistoryByteLimit, loadDocumentHistory, saveDocumentHistory } from './document-history'
import type { DocumentHistory, HistoryStorage } from './document-history'

const atoms: Atom[] = [{ componentId: 'button', name: 'Button', exportName: 'Button', path: 'src/atoms/Button.tsx', kind: 'atom', status: 'bound', fingerprint: 'button', sourceHash: 'hash', candidates: [], props: [{ name: 'children', type: 'ReactNode', optional: true }, { name: 'variant', type: '"primary" | "quiet"', optional: true }] }]

function file(revision: number, text = 'Sign in'): FileDocument {
  return {
    schemaVersion: 7, fileId: 'file-a', revision,
    pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
    nodes: {
      'root-1': { id: 'root-1', type: 'root' },
      submit: { id: 'submit', type: 'component', componentId: 'button', exportName: 'Button', props: { children: text, variant: 'primary' } },
      shape: { id: 'shape', type: 'rectangle', name: 'Shape', styles: { left: 10, top: 20, width: 120, height: 120 }, appearance: { fills: [{ id: 'shape-fill', type: 'solid', color: { kind: 'literal', color: { kind: 'hex', hex: '#d9d9d9' } } }] } },
    },
    relationships: { submit: { parentId: 'root-1', orderKey: 'V' }, shape: { parentId: 'root-1', orderKey: 'W' } },
    theme: { tokens: {} },
  }
}

function storage() {
  const data = new Map<string, string>()
  const removed: string[] = []
  const api: HistoryStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { removed.push(key); data.delete(key) } }
  return { data, removed, api }
}

const entry = (source: FileDocument, selection: string[] = [], afterSelection: string[] = selection) => ({
  file: source,
  pageId: 'page-1',
  selection,
  afterPageId: 'page-1',
  afterSelection,
  undo: { type: 'page.rename', pageId: 'page-1', name: source.pages[0]!.name } as const,
  redo: { type: 'page.rename', pageId: 'page-1', name: `${source.pages[0]!.name} edited` } as const,
})
const example = (): DocumentHistory => ({ past: [entry(file(1, 'Continue'), ['submit'])], future: [entry(file(3, 'Welcome'))] })
const keyA = 'design-editor:document-history:v3:file-a'
const keyB = 'design-editor:document-history:v3:file-b'
const text = (entry: { file: FileDocument } | undefined) => (entry?.file.nodes.submit as { props: { children: string } } | undefined)?.props.children

describe('persistent file undo history', () => {
  it('stores a version 3 payload and restores semantic history with page and selection', () => {
    const store = storage()
    const history = example()
    saveDocumentHistory(store.api, 'file-a', file(2), history)
    const payload = JSON.parse(store.data.get(keyA)!)
    expect(Object.keys(payload)).toEqual(['version', 'fileId', 'currentFile', 'history'])
    expect(payload.version).toBe(3)
    expect(payload.fileId).toBe('file-a')
    expect(payload.currentFile.revision).toBe(2)
    ;(history.past[0]!.file.nodes.submit as unknown as { props: { children: string } }).props.children = 'Caller changed its copy'
    const restored = loadDocumentHistory(store.api, 'file-a', file(2), atoms)
    expect(text(restored?.past[0])).toBe('Continue')
    expect(restored?.past[0]!.pageId).toBe('page-1')
    expect(restored?.past[0]!.selection).toEqual(['submit'])
    expect(restored?.past[0]!.undo).toEqual({ type: 'page.rename', pageId: 'page-1', name: 'Page 1' })
    expect(restored?.past[0]!.redo).toEqual({ type: 'page.rename', pageId: 'page-1', name: 'Page 1 edited' })
    expect(text(restored?.future[0])).toBe('Welcome')
    expect(restored?.future[0]!.selection).toEqual([])
    expect(store.removed).toEqual([])
  })

  it('encodes the file id in the key and never reads version 1 caches', () => {
    const store = storage()
    saveDocumentHistory(store.api, 'team/file a', file(2), example())
    expect([...store.data.keys()]).toEqual(['design-editor:document-history:v3:team%2Ffile%20a'])
    store.data.set('design-editor:document-history:v1:file-a', JSON.stringify({ version: 1, projectId: 'file-a', currentDocument: {}, history: { past: [], future: [] } }))
    expect(loadDocumentHistory(store.api, 'file-a', file(2), atoms)).toBeNull()
    expect(() => saveDocumentHistory(store.api, '', file(2), example())).toThrow('Invalid history file identity')
  })

  it('accepts selected primitives and rejects missing, root, or duplicate selections', () => {
    const store = storage()
    const current = file(2)
    saveDocumentHistory(store.api, 'file-a', current, { past: [entry(file(1), ['shape'])], future: [] })
    expect(loadDocumentHistory(store.api, 'file-a', current, atoms)?.past[0]!.selection).toEqual(['shape'])
    for (const selection of [['missing-shape'], ['root-1'], ['shape', 'shape']]) {
      saveDocumentHistory(store.api, 'file-a', current, { past: [entry(file(1), ['shape'])], future: [] })
      const payload = JSON.parse(store.data.get(keyA)!)
      payload.history.past[0].selection = selection
      store.data.set(keyA, JSON.stringify(payload))
      expect(loadDocumentHistory(store.api, 'file-a', current, atoms)).toBeNull()
      expect(store.data.has(keyA)).toBe(false)
    }
  })

  it('rejects changed revisions and same-revision changed content, evicting only this file', () => {
    const store = storage()
    saveDocumentHistory(store.api, 'file-b', file(2), example())
    saveDocumentHistory(store.api, 'file-a', file(2), example())
    expect(loadDocumentHistory(store.api, 'file-a', file(3), atoms)).toBeNull()
    expect(store.removed).toEqual([keyA])
    expect(loadDocumentHistory(store.api, 'file-b', file(2), atoms)?.past[0]!.selection).toEqual(['submit'])
    saveDocumentHistory(store.api, 'file-a', file(2), example())
    expect(loadDocumentHistory(store.api, 'file-a', file(2, 'Changed externally'), atoms)).toBeNull()
  })

  it('never reads another file or accepts a copied foreign cache', () => {
    const store = storage()
    saveDocumentHistory(store.api, 'file-a', file(2), example())
    expect(loadDocumentHistory(store.api, 'file-b', file(2), atoms)).toBeNull()
    store.data.set(keyB, store.data.get(keyA)!)
    expect(loadDocumentHistory(store.api, 'file-b', file(2), atoms)).toBeNull()
    expect(store.data.has(keyB)).toBe(false)
    expect(store.data.has(keyA)).toBe(true)
  })

  it.each(['malformed', 'unknown-field', 'old-version', 'bad-prop', 'wrong-identity', 'missing-page', 'entry-field', 'slot', 'orphan', 'prototype'])('rejects %s payloads before history reaches the store', failure => {
    const store = storage()
    saveDocumentHistory(store.api, 'file-a', file(2), example())
    if (failure === 'malformed') store.data.set(keyA, '{broken')
    else {
      const payload = JSON.parse(store.data.get(keyA)!)
      const past = payload.history.past[0]
      if (failure === 'unknown-field') payload.exec = 'x'
      if (failure === 'old-version') payload.version = 1
      if (failure === 'bad-prop') past.file.nodes.submit.props.variant = 'invented'
      if (failure === 'wrong-identity') past.file.nodes.submit.componentId = 'unknown'
      if (failure === 'missing-page') past.pageId = 'page-404'
      if (failure === 'entry-field') past.document = past.file
      if (failure === 'slot') past.file.relationships.submit.slot = 'children'
      if (failure === 'orphan') delete past.file.relationships.shape
      if (failure === 'prototype') past.file.nodes.submit.props = JSON.parse('{"__proto__":{"polluted":true}}')
      store.data.set(keyA, JSON.stringify(payload))
    }
    expect(loadDocumentHistory(store.api, 'file-a', file(2), atoms)).toBeNull()
    expect(store.data.has(keyA)).toBe(false)
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false)
  })

  it('retains the twenty nearest entries with future first and rejects oversized stored entry arrays', () => {
    const store = storage()
    const history = { past: Array.from({ length: 30 }, (_, index) => entry(file(index), ['submit'])), future: [entry(file(40)), entry(file(41))] }
    saveDocumentHistory(store.api, 'file-a', file(31), history)
    const restored = loadDocumentHistory(store.api, 'file-a', file(31), atoms)!
    expect(restored.past.map(entry => entry.file.revision)).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29])
    expect(restored.future.map(entry => entry.file.revision)).toEqual([40, 41])
    expect(history.past).toHaveLength(30)
    const payload = JSON.parse(store.data.get(keyA)!)
    payload.history.past.push(entry(file(30)))
    store.data.set(keyA, JSON.stringify(payload))
    expect(loadDocumentHistory(store.api, 'file-a', file(31), atoms)).toBeNull()
  })

  it('retains no past entries when twenty nearest redos consume the budget', () => {
    const store = storage()
    saveDocumentHistory(store.api, 'file-a', file(2), { past: example().past, future: Array.from({ length: 25 }, (_, index) => entry(file(index))) })
    const restored = loadDocumentHistory(store.api, 'file-a', file(2), atoms)!
    expect(restored.past).toEqual([])
    expect(restored.future.map(entry => entry.file.revision)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24])
  })

  it('trims the oldest entries to the UTF-8 byte budget without modifying the original arrays', () => {
    const store = storage()
    const large = file(1)
    // 50 components carrying 3000 three-byte characters each: about 450 KB per entry, so four entries fit in 2 MiB and five do not.
    for (let index = 0; index < 50; index++) {
      const id = `button-${index}`
      large.nodes[id] = { id, type: 'component', componentId: 'button', exportName: 'Button', props: { children: '界'.repeat(3000) } }
      large.relationships[id] = { parentId: 'root-1', orderKey: 'X' }
    }
    const history = { past: Array.from({ length: 8 }, (_, index) => entry({ ...large, revision: index + 1 })), future: [] }
    saveDocumentHistory(store.api, 'file-a', file(9), history)
    expect(new TextEncoder().encode(store.data.get(keyA)!).byteLength).toBeLessThanOrEqual(documentHistoryByteLimit)
    const restored = loadDocumentHistory(store.api, 'file-a', file(9), atoms)!
    expect(restored.past.map(entry => entry.file.revision)).toEqual([5, 6, 7, 8])
    expect(history.past).toHaveLength(8)
  })

  it('propagates unavailable storage, quota, and eviction errors for visible recovery', () => {
    const quota = new Error('Storage quota reached')
    const api: HistoryStorage = { getItem: () => { throw quota }, setItem: () => { throw quota }, removeItem: () => { throw quota } }
    expect(() => saveDocumentHistory(api, 'file-a', file(2), example())).toThrow(quota)
    expect(() => loadDocumentHistory(api, 'file-a', file(2), atoms)).toThrow(quota)
    expect(() => loadDocumentHistory({ ...api, getItem: () => '{broken' }, 'file-a', file(2), atoms)).toThrow(quota)
  })

  it('evicts an oversized cache only for its file and rejects an uncacheable current file', () => {
    const store = storage()
    saveDocumentHistory(store.api, 'file-b', file(2), example())
    store.data.set(keyA, ' '.repeat(documentHistoryByteLimit + 1))
    expect(loadDocumentHistory(store.api, 'file-a', file(2), atoms)).toBeNull()
    expect(store.removed).toEqual([keyA])
    expect(() => saveDocumentHistory(store.api, 'file-a', file(2, 'x'.repeat(documentHistoryByteLimit)), example())).toThrow('too large')
    expect(text(loadDocumentHistory(store.api, 'file-b', file(2), atoms)?.future[0])).toBe('Welcome')
  })
})
