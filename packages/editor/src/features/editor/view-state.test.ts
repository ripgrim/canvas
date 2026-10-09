import { describe, expect, it } from 'vitest'
import { readFileView, writeFileView } from './view-state'
import type { FileViewState } from './view-state'

const key = 'design-editor.view-state.v1'
function memory(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [[key, initial]])
  return { values, api: { getItem: (name: string) => values.get(name) ?? null, setItem: (name: string, value: string) => { values.set(name, value) } } }
}
const view = (fileId = 'file-a'): FileViewState => ({ fileId, activePageId: 'page-2', previewThemeId: 'dark', pageViews: { 'page-1': { camera: { x: 10, y: -20, zoom: 1.5 } } } })

describe('AT-FILE per-file view state', () => {
  it('round trips one file view and keeps other files', () => {
    const store = memory()
    writeFileView(view('file-a'), store.api)
    writeFileView({ ...view('file-b'), activePageId: 'page-9' }, store.api)
    expect(readFileView('file-a', store.api)).toEqual({ fileId: 'file-a', activePageId: 'page-2', previewThemeId: 'dark', pageViews: { 'page-1': { camera: { x: 10, y: -20, zoom: 1.5 } } } })
    expect(readFileView('file-b', store.api)?.activePageId).toBe('page-9')
    expect(Object.keys(JSON.parse(store.values.get(key)!).files)).toEqual(['file-a', 'file-b'])
    writeFileView({ ...view('file-a'), previewThemeId: 'default' }, store.api)
    expect(readFileView('file-a', store.api)?.previewThemeId).toBe('default')
    expect(readFileView('file-b', store.api)?.activePageId).toBe('page-9')
  })

  it('returns null for an unknown file or missing storage', () => {
    const store = memory()
    writeFileView(view('file-a'), store.api)
    expect(readFileView('file-z', store.api)).toBeNull()
    expect(readFileView('file-a', null)).toBeNull()
    expect(() => writeFileView(view('file-a'), null)).not.toThrow()
  })

  it('ignores invalid records and invalid cameras while keeping valid ones', () => {
    const store = memory(JSON.stringify({ schemaVersion: 1, files: {
      'file-a': { fileId: 'file-a', activePageId: 'page-1', previewThemeId: 'default', pageViews: { 'page-1': { camera: { x: 1, y: 2, zoom: 1 } }, 'page-2': { camera: { x: 1, y: 2, zoom: 0 } }, 'page-3': { camera: { x: '1', y: 2, zoom: 1 } }, 'page-4': null } },
      'file-b': { fileId: 'file-other', activePageId: 'page-1', previewThemeId: 'default', pageViews: {} },
      'file-c': { fileId: 'file-c', activePageId: 'bad page', previewThemeId: 'default', pageViews: {} },
      'file-d': { fileId: 'file-d', activePageId: 'page-1', previewThemeId: 'default' },
    } }))
    expect(readFileView('file-a', store.api)).toEqual({ fileId: 'file-a', activePageId: 'page-1', previewThemeId: 'default', pageViews: { 'page-1': { camera: { x: 1, y: 2, zoom: 1 } } } })
    expect(readFileView('file-b', store.api)).toBeNull()
    expect(readFileView('file-c', store.api)).toBeNull()
    expect(readFileView('file-d', store.api)).toBeNull()
  })

  it('treats an unknown schema or malformed JSON as empty', () => {
    const record = { 'file-a': view('file-a') }
    expect(readFileView('file-a', memory(JSON.stringify({ schemaVersion: 2, files: record })).api)).toBeNull()
    expect(readFileView('file-a', memory('{broken').api)).toBeNull()
    const store = memory('{broken')
    writeFileView(view('file-a'), store.api)
    expect(readFileView('file-a', store.api)?.activePageId).toBe('page-2')
  })

  it('does not write an invalid view and survives a failing store', () => {
    const store = memory()
    writeFileView({ ...view('file-a'), activePageId: '' }, store.api)
    expect(store.values.has(key)).toBe(false)
    const full = { getItem: () => null, setItem: () => { throw new Error('Quota exceeded') } }
    expect(() => writeFileView(view('file-a'), full)).not.toThrow()
  })
})
