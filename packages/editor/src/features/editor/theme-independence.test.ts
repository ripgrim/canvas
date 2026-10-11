import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { createDocumentStore } from './document-store'
import { createEditorStore } from './store'
import type { HistoryStorage } from './document-history'
import type { DesignEditorApi, ProjectSnapshot } from './types'

// LAY-THEME-001: the editor appearance preference and the design preview theme are independent states with
// independent storage keys. Both keys live in one browser storage, as they do in the app, so a write to the wrong
// key would be visible here. store.test.ts already checks that setAppearance leaves previewThemeId alone in memory.

const appearanceKey = 'design-editor.appearance.v1'
const viewKey = 'design-editor.view-state.v1'

const file = (): FileDocument => ({
  schemaVersion: 7, fileId: 'file-a', revision: 1,
  pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
  nodes: { 'root-1': { id: 'root-1', type: 'root' } },
  relationships: {},
  theme: { tokens: {} },
})
const project = (): ProjectSnapshot => ({
  projectId: 'fixture-project', fileId: 'file-a', atoms: [], sourceHashes: {},
  composition: { id: 'login', name: 'Login', componentId: null, children: [] },
  file: file(), sourceHistory: [], conflict: null, phases: [], tokens: [],
  preview: { status: 'stopped', currentGeneration: 0, activeGeneration: null, origin: null, url: null, stale: false, diagnostics: [] },
  designThemes: [{ id: 'default', name: 'Default', selector: ':root', attribute: null, colorScheme: 'light' }, { id: 'dark', name: 'Dark', selector: '[data-theme=dark]', attribute: 'dark', colorScheme: 'dark' }],
})

/** One in-memory browser storage that records every write by key. */
function browserStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  const writes: string[] = []
  const api: HistoryStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { writes.push(key); values.set(key, value) },
    removeItem: key => { writes.push(key); values.delete(key) },
  }
  return { values, writes, api }
}
const storedView = (previewThemeId: string) => ({ [viewKey]: JSON.stringify({ schemaVersion: 1, files: { 'file-a': { fileId: 'file-a', activePageId: 'page-1', previewThemeId, pageViews: { 'page-1': { camera: { x: 4, y: 8, zoom: 1 } } } } } }) })
const previewThemeIn = (values: Map<string, string>) => JSON.parse(values.get(viewKey)!).files['file-a'].previewThemeId

function open(storage: ReturnType<typeof browserStorage>) {
  // The appearance preference reads and writes window.localStorage; the store reads view state from its storage port.
  vi.stubGlobal('window', { localStorage: storage.api })
  const unavailable = { available: false, reason: 'Unavailable' }
  const available = { available: true, reason: 'Fixture' }
  const api = {
    capabilities: { runtime: 'desktop', openLabel: 'Open fixture', files: { list: available, create: unavailable, open: available }, sourceWrites: unavailable, localRepository: available, hostedExecution: unavailable, git: unavailable, mcp: unavailable, hostedProjects: unavailable },
    listFiles: async () => [{ id: 'file-a', name: 'Login', location: 'local' }],
    openFile: async () => project(),
    openProject: async () => project(),
  } as unknown as DesignEditorApi
  return createEditorStore(() => api, createDocumentStore(() => 'new-id'), () => storage.api)
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('LAY-THEME-001 editor appearance and preview theme independence', () => {
  it('changing the preview theme never writes or changes the editor appearance key', async () => {
    const storage = browserStorage({ [appearanceKey]: 'dark' })
    const store = open(storage)
    expect(store.getSnapshot().mode).toBe('dark')
    await store.openFile('file-a')
    vi.runAllTimers()
    expect(store.getSnapshot().previewThemeId).toBe('default')
    storage.writes.length = 0
    expect(store.setPreviewTheme('dark')).toBe(true)
    expect(store.setPreviewTheme('default')).toBe(true)
    expect(store.setPreviewTheme('dark')).toBe(true)
    vi.runAllTimers()
    expect(storage.writes).toEqual([viewKey, viewKey, viewKey])
    expect(previewThemeIn(storage.values)).toBe('dark')
    expect(storage.values.get(appearanceKey)).toBe('dark')
    expect(store.getSnapshot().mode).toBe('dark')
  })

  it('changing the editor appearance never writes or changes the preview theme view state', async () => {
    const storage = browserStorage(storedView('dark'))
    const store = open(storage)
    expect(store.getSnapshot().mode).toBe('light')
    await store.openFile('file-a')
    vi.runAllTimers()
    expect(store.getSnapshot().previewThemeId).toBe('dark')
    const viewBytes = storage.values.get(viewKey)
    storage.writes.length = 0
    store.setAppearance('dark')
    store.setAppearance('light')
    store.setAppearance('dark')
    vi.runAllTimers()
    expect(storage.writes).toEqual([appearanceKey, appearanceKey, appearanceKey])
    expect(storage.values.get(appearanceKey)).toBe('dark')
    expect(storage.values.get(viewKey)).toBe(viewBytes)
    expect(store.getSnapshot().previewThemeId).toBe('dark')
    expect(store.getSnapshot().mode).toBe('dark')
  })

  it.each([
    ['light', 'default'],
    ['light', 'dark'],
    ['dark', 'default'],
    ['dark', 'dark'],
  ] as const)('restores appearance %s and preview theme %s each from its own key after a reload', async (appearance, previewTheme) => {
    const storage = browserStorage({ [appearanceKey]: appearance, ...storedView(previewTheme) })
    const store = open(storage)
    await store.openFile('file-a')
    vi.runAllTimers()
    expect(store.getSnapshot().mode).toBe(appearance)
    expect(store.getSnapshot().previewThemeId).toBe(previewTheme)
    expect(storage.values.get(appearanceKey)).toBe(appearance)
    expect(previewThemeIn(storage.values)).toBe(previewTheme)
  })

  it('falls back on each preference alone when only the other key is present (negative control)', async () => {
    const onlyView = browserStorage(storedView('dark'))
    const first = open(onlyView)
    await first.openFile('file-a')
    vi.runAllTimers()
    expect(first.getSnapshot().mode).toBe('light')
    expect(first.getSnapshot().previewThemeId).toBe('dark')
    expect(onlyView.values.has(appearanceKey)).toBe(false)

    const onlyAppearance = browserStorage({ [appearanceKey]: 'dark' })
    const second = open(onlyAppearance)
    await second.openFile('file-a')
    vi.runAllTimers()
    expect(second.getSnapshot().mode).toBe('dark')
    expect(second.getSnapshot().previewThemeId).toBe('default')
    expect(previewThemeIn(onlyAppearance.values)).toBe('default')
  })
})
