import { describe, expect, it, vi } from 'vitest'
import { authSessionView } from '@canvas/auth'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { EditorCollaborationSnapshot, EditorProjectFailure } from './capabilities'
import { bindAuthFileClear, bindProjectFailures, bindShareAuthority } from './bootstrap'
import { createDocumentStore } from './features/editor/document-store'
import { createEditorStore } from './features/editor/store'
import type { DesignEditorApi, ProjectSnapshot } from './features/editor/types'

const snapshot = (canManageShare: boolean): EditorCollaborationSnapshot => Object.freeze({
  status: canManageShare ? 'live' : 'read-only',
  localClientId: 'tab-local',
  localProfile: Object.freeze({ subjectId: 'user-local', displayName: 'Local', avatarUrl: null, role: canManageShare ? 'owner' : 'viewer' }),
  canMutate: canManageShare,
  canManageShare,
  participants: Object.freeze([]),
  agents: Object.freeze([]),
  error: null,
})

describe('CLOUD-SYNC-LIFECYCLE-001 share authority binding', () => {
  it('publishes authority and removes its owned subscription exactly once', () => {
    let current = snapshot(true)
    const listeners = new Set<() => void>()
    const unsubscribe = vi.fn()
    const target = { setShareAuthority: vi.fn() }
    const dispose = bindShareAuthority({
      collaboration: {
        getSnapshot: () => current,
        subscribe: listener => {
          listeners.add(listener)
          return () => { listeners.delete(listener); unsubscribe() }
        },
        updateAwareness: () => undefined,
      },
    }, target)

    expect(target.setShareAuthority).toHaveBeenLastCalledWith(true)
    current = snapshot(false)
    for (const listener of listeners) listener()
    expect(target.setShareAuthority).toHaveBeenLastCalledWith(false)

    dispose()
    dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(0)
  })
})

describe('ERROR-VISIBILITY-001 project failure binding', () => {
  it('surfaces adapter asset hydration failures and removes its subscription exactly once', () => {
    const listeners = new Set<(failure: EditorProjectFailure) => void>()
    const unsubscribe = vi.fn()
    const target = { error: vi.fn() }
    const dispose = bindProjectFailures({
      subscribeFailures: listener => {
        listeners.add(listener)
        return () => { listeners.delete(listener); unsubscribe() }
      },
    }, target)

    for (const listener of listeners) listener({ operation: 'asset_hydration', error: new Error('The image download was interrupted. Try again.') })
    expect(target.error).toHaveBeenCalledWith("Image couldn't be loaded", 'The image download was interrupted. Try again.')

    dispose()
    dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(0)
  })

  it('uses concise image copy when the adapter failure is not safe to display', () => {
    const target = { error: vi.fn() }
    const dispose = bindProjectFailures({ subscribeFailures: listener => { listener({ operation: 'asset_hydration', error: null }); return vi.fn() } }, target)
    expect(target.error).toHaveBeenCalledWith("Image couldn't be loaded", "Image couldn't be loaded")
    dispose()
  })
})

describe('AT-AUTH-003 authenticated file boundary', () => {
  it('clears the rendered file before the browser reloads after sign-out', async () => {
    const file: FileDocument = {
      schemaVersion: 7,
      fileId: 'file-auth',
      revision: 1,
      pages: [{ id: 'page-1', name: 'Page 1', rootNodeId: 'root-1' }],
      nodes: { 'root-1': { id: 'root-1', type: 'root' } },
      relationships: {},
      theme: { tokens: {} },
    }
    const project: ProjectSnapshot = {
      projectId: 'project-auth',
      fileId: file.fileId,
      atoms: [],
      sourceHashes: {},
      composition: { id: 'composition-auth', name: 'Private file', componentId: null, children: [] },
      file,
      sourceHistory: [],
      conflict: null,
      phases: [],
      tokens: [],
      preview: { status: 'stopped', currentGeneration: 0, activeGeneration: null, origin: null, url: null, stale: false, diagnostics: [] },
      designThemes: [{ id: 'default', name: 'Default', selector: ':root', attribute: null, colorScheme: 'light' }],
    }
    const api = { openFile: vi.fn(async () => project) } as unknown as DesignEditorApi
    const documents = createDocumentStore(() => 'test-id')
    const store = createEditorStore(() => api, documents)
    await store.openFile(file.fileId)

    let session = authSessionView('signed-in', { id: 'user-1', name: 'Ada', email: 'ada@example.test', avatarUrl: null })
    const listeners = new Set<() => void>()
    const source = {
      getSnapshot: () => session,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    }
    const stop = bindAuthFileClear(source, store)
    const reload = vi.fn(() => {
      expect(store.getSnapshot().snapshot).toBeNull()
      expect(documents.getSnapshot().file).toBeNull()
    })

    session = authSessionView('signed-out')
    for (const listener of listeners) listener()
    reload()

    expect(reload).toHaveBeenCalledOnce()
    stop()
    store.dispose()
    documents.dispose()
  })
})
