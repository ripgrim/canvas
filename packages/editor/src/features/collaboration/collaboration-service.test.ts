import { describe, expect, it, vi } from 'vitest'
import type { EditorCollaborationApi, EditorCollaborationParticipant, EditorCollaborationPatch, EditorCollaborationSnapshot } from '../../capabilities'
import type { DocumentState } from '../editor/document-store'
import { documentStore } from '../editor/document-store'
import type { CollaborationAnimationClock } from './collaboration-service'
import { createCollaborationService } from './collaboration-service'

const awareness = (pageId: string | null = 'page-1', x = 10) => ({ pageId, focused: true, selection: pageId ? { pageId, nodeIds: ['node-1'] } : null, camera: pageId ? { pageId, x, y: 20, zoom: 2 } : null, cursor: pageId ? { pageId, x: 5, y: 6 } : null })
const participant = (presenceId: string, clientId: string, pageId: string | null = 'page-1', x = 10): EditorCollaborationParticipant => ({ presenceId, subjectId: `user-${presenceId}`, displayName: presenceId, avatarUrl: null, clientId, role: 'owner', isHeadless: false, sequence: 1, awareness: awareness(pageId, x) })
const snapshot = (status: EditorCollaborationSnapshot['status'], localClientId: string, participants: readonly EditorCollaborationParticipant[], canMutate = status === 'live'): EditorCollaborationSnapshot => ({
  status, localClientId, localProfile: { subjectId: 'user-local', displayName: 'local', avatarUrl: null, role: canMutate ? 'owner' : 'viewer' },
  canMutate, canManageShare: canMutate, participants, agents: [], error: null,
})

function collaboration(initial: EditorCollaborationSnapshot) {
  let current = initial
  const listeners = new Set<() => void>()
  const updates: EditorCollaborationPatch[] = []
  const updateOptions: Array<Readonly<{ immediate?: boolean }> | undefined> = []
  const api: EditorCollaborationApi = {
    getSnapshot: () => current,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    updateAwareness: (patch, options) => { updates.push(patch); updateOptions.push(options) },
  }
  return {
    api,
    updates,
    updateOptions,
    listenerCount: () => listeners.size,
    publish: (next: EditorCollaborationSnapshot) => { current = next; for (const listener of listeners) listener() },
  }
}

describe('CLOUD-SYNC-GESTURE-001 collaboration gesture ownership', () => {
  it('publishes every transform immediately and releases the node lock', () => {
    const docs = documents()
    const local = participant('local', 'tab-local')
    const remote = participant('remote', 'tab-remote')
    const transport = collaboration(snapshot('live', 'tab-local', [local, remote]))
    const service = createCollaborationService(docs.api, fakeWindow, animationClock().clock)
    service.configure(transport.api)
    service.start()

    const interactionId = service.beginInteraction('move', ['node-1'])
    expect(interactionId).toBeTypeOf('string')
    expect(service.updateInteraction(interactionId!, [{ nodeId: 'node-1', dx: 1, dy: 2 }])).toBe(true)
    expect(service.updateInteraction(interactionId!, [{ nodeId: 'node-1', dx: 3, dy: 4 }])).toBe(true)
    service.endInteraction(interactionId!)

    const interactionUpdates = transport.updates.filter(update => Object.hasOwn(update, 'interaction'))
    expect(interactionUpdates.every(update => update.pageId === 'page-1')).toBe(true)
    expect(interactionUpdates.map(update => update.interaction?.transforms[0] ?? null)).toEqual([
      null,
      { nodeId: 'node-1', dx: 1, dy: 2 },
      { nodeId: 'node-1', dx: 3, dy: 4 },
      null,
    ])
    expect(transport.updateOptions.slice(-4)).toEqual([{ immediate: true }, { immediate: true }, { immediate: true }, { immediate: true }])
    service.stop()
  })

  it('refuses a node already held by another participant', () => {
    const docs = documents()
    const local = participant('local', 'tab-local')
    const remote = { ...participant('remote', 'tab-remote'), awareness: { ...awareness(), interaction: { interactionId: 'remote-gesture', pageId: 'page-1', kind: 'move' as const, nodeIds: ['node-1'], transforms: [] } } }
    const transport = collaboration(snapshot('live', 'tab-local', [local, remote]))
    const service = createCollaborationService(docs.api, fakeWindow, animationClock().clock)
    service.configure(transport.api)
    service.start()
    expect(service.isNodeLocked('node-1')).toBe(true)
    expect(service.beginInteraction('move', ['node-1'])).toBeNull()
    expect(transport.updates.some(update => update.interaction !== undefined)).toBe(false)
    service.stop()
  })

  it('yields a local interaction to any overlapping server-authoritative remote lock', async () => {
    const docs = documents()
    const local = participant('00000000-local', 'tab-local')
    const remote = participant('ffffffff-remote', 'tab-remote')
    const transport = collaboration(snapshot('live', 'tab-local', [local, remote]))
    const service = createCollaborationService(docs.api, fakeWindow, animationClock().clock)
    service.configure(transport.api)
    service.start()
    const interactionId = service.beginInteraction('move', ['node-1'])
    expect(interactionId).toBeTypeOf('string')
    const permission = service.waitForCommitInteraction(interactionId!)

    transport.publish(snapshot('live', 'tab-local', [local, {
      ...remote,
      awareness: { ...awareness(), interaction: { interactionId: 'authoritative-remote', pageId: 'page-1', kind: 'move' as const, nodeIds: ['node-1'], transforms: [] } },
    }]))

    await expect(permission).resolves.toBe(false)
    expect(service.updateInteraction(interactionId!, [{ nodeId: 'node-1', dx: 4, dy: 5 }])).toBe(false)
    expect(transport.updates.at(-1)).toEqual({ pageId: 'page-1', interaction: null })
    service.stop()
  })

  it('requires the room echo before an interaction can commit', async () => {
    const docs = documents()
    const local = participant('local', 'tab-local')
    const transport = collaboration(snapshot('live', 'tab-local', [local]))
    const service = createCollaborationService(docs.api, fakeWindow, animationClock().clock)
    service.configure(transport.api)
    service.start()

    const interactionId = service.beginInteraction('move', ['node-1'])
    expect(interactionId).toBeTypeOf('string')
    expect(service.canCommitInteraction(interactionId!)).toBe(false)
    const permission = service.waitForCommitInteraction(interactionId!)
    let settled: boolean | undefined
    void permission.then(allowed => { settled = allowed })
    await Promise.resolve()
    expect(settled).toBeUndefined()
    const requested = transport.updates.find(update => update.interaction)?.interaction
    expect(requested).toBeTruthy()

    transport.publish(snapshot('live', 'tab-local', [{
      ...local,
      sequence: 2,
      awareness: { ...local.awareness, interaction: requested! },
    }]))

    expect(service.canCommitInteraction(interactionId!)).toBe(true)
    await expect(permission).resolves.toBe(true)
    service.endInteraction(interactionId!)
    expect(service.canCommitInteraction(interactionId!)).toBe(false)
    service.stop()
  })

  it('fails closed when interaction publication fails', () => {
    const docs = documents()
    const local = participant('local', 'tab-local')
    const transport = collaboration(snapshot('live', 'tab-local', [local]))
    const failure = new Error('socket closed')
    const reportError = vi.fn()
    const service = createCollaborationService(docs.api, fakeWindow, animationClock().clock, reportError)
    service.configure({ ...transport.api, updateAwareness: () => { throw failure } })
    service.start()
    reportError.mockClear()

    expect(service.beginInteraction('move', ['node-1'])).toBeNull()
    expect(service.updateInteraction('missing-interaction', [{ nodeId: 'node-1', dx: 1, dy: 2 }])).toBe(false)
    expect(service.canCommitInteraction('missing-interaction')).toBe(false)
    expect(reportError).toHaveBeenCalledWith(failure, 'awareness')
    service.stop()
  })

  it('cancels ownership when a transform sample cannot be published', () => {
    const docs = documents()
    const local = participant('local', 'tab-local')
    const transport = collaboration(snapshot('live', 'tab-local', [local]))
    const failure = new Error('socket closed')
    const reportError = vi.fn()
    const service = createCollaborationService(docs.api, fakeWindow, animationClock().clock, reportError)
    service.configure({
      ...transport.api,
      updateAwareness: (patch, options) => {
        if (options?.immediate && patch.interaction?.transforms.length) throw failure
        transport.api.updateAwareness(patch, options)
      },
    })
    service.start()

    const interactionId = service.beginInteraction('move', ['node-1'])
    expect(interactionId).toBeTypeOf('string')
    expect(service.updateInteraction(interactionId!, [{ nodeId: 'node-1', dx: 1, dy: 2 }])).toBe(false)
    expect(service.canCommitInteraction(interactionId!)).toBe(false)
    expect(reportError).toHaveBeenCalledWith(failure, 'awareness')
    service.stop()
  })

  it('does not let an old interaction lease release a newer room interaction', () => {
    const docs = documents()
    const local = participant('local', 'tab-local')
    const first = collaboration(snapshot('live', 'tab-local', [local]))
    const second = collaboration(snapshot('live', 'tab-local', [local]))
    const service = createCollaborationService(docs.api, fakeWindow, animationClock().clock)
    service.configure(first.api)
    service.start()
    const firstId = service.beginInteraction('move', ['node-1'])
    expect(firstId).toBeTypeOf('string')

    service.configure(second.api)
    const secondId = service.beginInteraction('move', ['node-1'])
    expect(secondId).toBeTypeOf('string')
    const updatesBeforeStaleRelease = second.updates.length

    service.endInteraction(firstId!)

    expect(second.updates).toHaveLength(updatesBeforeStaleRelease)
    expect(second.updates.at(-1)?.interaction?.interactionId).toBe(secondId)
    service.endInteraction(secondId!)
    expect(second.updates.at(-1)).toEqual({ pageId: 'page-1', interaction: null })
    service.stop()
  })

  it('does not overwrite a local interaction while its lease is active', () => {
    const docs = documents()
    const local = participant('local', 'tab-local')
    const transport = collaboration(snapshot('live', 'tab-local', [local]))
    const service = createCollaborationService(docs.api, fakeWindow, animationClock().clock)
    service.configure(transport.api)
    service.start()

    const interactionId = service.beginInteraction('move', ['node-1'])
    expect(interactionId).toBeTypeOf('string')
    expect(service.beginInteraction('resize', ['node-1'])).toBeNull()
    expect(transport.updates.filter(update => update.interaction)).toHaveLength(1)

    service.endInteraction(interactionId!)
    service.stop()
  })
})

function documents() {
  let state = { pageId: 'page-1', selection: ['node-1'], viewport: { x: 0, y: 0, zoom: 1 }, readOnly: false, file: { pages: [{ id: 'page-1' }, { id: 'page-2' }] } } as unknown as DocumentState
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  const api = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    setPage: (pageId: string) => { state = { ...state, pageId }; notify() },
    setViewport: (viewport: DocumentState['viewport']) => { state = { ...state, viewport }; notify() },
    setReadOnly: (readOnly: boolean) => { state = { ...state, readOnly }; notify() },
  } as unknown as typeof documentStore
  return {
    api,
    get: () => state,
    listenerCount: () => listeners.size,
    setViewport: (viewport: DocumentState['viewport']) => { state = { ...state, viewport: { ...viewport } }; notify() },
    select: (selection: string[]) => { state = { ...state, selection }; notify() },
  }
}

function animationClock(reduced = false) {
  let id = 0
  const callbacks = new Map<number, () => void>()
  const cancelled = new Set<number>()
  const clock: CollaborationAnimationClock = {
    schedule: callback => { const handle = ++id; callbacks.set(handle, callback); return handle },
    cancel: handle => { cancelled.add(handle as number) },
    reducedMotion: () => reduced,
  }
  return {
    clock,
    flush: () => { const next = [...callbacks.entries()].find(([handle]) => !cancelled.has(handle)); if (!next) return false; callbacks.delete(next[0]); next[1](); return true },
    flushAll: () => { let count = 0; while (count < 100 && [...callbacks.keys()].some(handle => !cancelled.has(handle))) { const next = [...callbacks.entries()].find(([handle]) => !cancelled.has(handle))!; callbacks.delete(next[0]); next[1](); count++ } return count },
    force: (handle: number) => callbacks.get(handle)?.(),
    handles: () => [...callbacks.keys()],
    cancelled,
  }
}

const fakeWindow = { document: { hasFocus: () => true }, addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Window

function trackedWindow() {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
  const browser = {
    document: { hasFocus: () => true },
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      const current = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>()
      current.add(listener)
      listeners.set(type, current)
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => { listeners.get(type)?.delete(listener) },
  } as unknown as Window
  return { browser, listenerCount: (type: string) => listeners.get(type)?.size ?? 0 }
}

describe('UI-COLLAB-FOLLOW-001 collaboration follow service', () => {
  it('follows a valid remote camera and stops on a same-value local camera command, not selection churn', () => {
    const docs = documents()
    const local = participant('local', 'tab-local')
    const remote = participant('remote', 'tab-remote', 'page-2', 80)
    const transport = collaboration(snapshot('live', 'tab-local', [local, remote]))
    const service = createCollaborationService(docs.api, fakeWindow, animationClock().clock)
    service.configure(transport.api)
    service.start()

    expect(service.follow('remote')).toBe(true)
    expect(docs.get()).toMatchObject({ pageId: 'page-2', viewport: { x: 80, y: 20, zoom: 2 } })
    docs.select(['node-2'])
    expect(service.getFollowingSnapshot()).toBe('remote')
    docs.setViewport({ x: 80, y: 20, zoom: 2 })
    expect(service.getFollowingSnapshot()).toBeNull()
    service.stop()
  })

  it('rejects missing, local, and page-or-camera-less follow targets without changing layout state', () => {
    const docs = documents()
    const local = participant('local', 'tab-local')
    const noCamera = participant('remote', 'tab-remote', null)
    const transport = collaboration(snapshot('live', 'tab-local', [local, noCamera]))
    const service = createCollaborationService(docs.api, fakeWindow, animationClock().clock)
    service.configure(transport.api)
    service.start()
    expect(service.follow('missing')).toBe(false)
    expect(service.follow('local')).toBe(false)
    expect(service.follow('remote')).toBe(false)
    expect(service.getFollowingSnapshot()).toBeNull()
    service.stop()
  })

  it('publishes following changes through a stable primitive subscription only', () => {
    const docs = documents()
    const local = participant('local', 'tab-local')
    const remote = participant('remote', 'tab-remote')
    const transport = collaboration(snapshot('live', 'tab-local', [local, remote]))
    const service = createCollaborationService(docs.api, fakeWindow, animationClock().clock)
    let followingChanges = 0
    service.subscribeFollowing(() => { followingChanges++ })
    service.configure(transport.api)
    service.start()
    transport.publish(snapshot('live', 'tab-local', [local, { ...remote, sequence: 2, awareness: { ...remote.awareness, cursor: { pageId: 'page-1', x: 200, y: 200 } } }]))
    expect(followingChanges).toBe(0)
    expect(service.follow('remote')).toBe(true)
    expect(followingChanges).toBe(1)
    service.stopFollowing()
    expect(followingChanges).toBe(2)
    service.stop()
  })
})

describe('UI-COLLAB-PRESENCE-001 cursor animation service', () => {
  it('does not snap an 800 by 800 delta, halves on owned ticks, and settles exactly', () => {
    const docs = documents()
    const local = participant('local', 'tab-local')
    const remote = participant('remote', 'tab-remote')
    const transport = collaboration(snapshot('live', 'tab-local', [local, remote]))
    const animation = animationClock()
    const service = createCollaborationService(docs.api, fakeWindow, animation.clock)
    service.configure(transport.api)
    service.start()
    const moved = { ...remote, sequence: 2, awareness: { ...remote.awareness, cursor: { pageId: 'page-1', x: 805, y: 806 } } }
    transport.publish(snapshot('live', 'tab-local', [local, moved]))
    expect(service.getSnapshot().cursorPositions.remote).toEqual({ pageId: 'page-1', x: 5, y: 6 })
    expect(animation.flush()).toBe(true)
    expect(service.getSnapshot().cursorPositions.remote).toEqual({ pageId: 'page-1', x: 405, y: 406 })
    expect(animation.flushAll()).toBeGreaterThan(0)
    expect(service.getSnapshot().cursorPositions.remote).toEqual(moved.awareness.cursor)
    service.stop()
  })

  it('snaps when either axis exceeds 1,000 and when reduced motion is requested', () => {
    const docs = documents()
    const local = participant('local', 'tab-local')
    const remote = participant('remote', 'tab-remote')
    const transport = collaboration(snapshot('live', 'tab-local', [local, remote]))
    const service = createCollaborationService(docs.api, fakeWindow, animationClock().clock)
    service.configure(transport.api)
    service.start()
    const distant = { ...remote, sequence: 2, awareness: { ...remote.awareness, cursor: { pageId: 'page-1', x: 1_006, y: 806 } } }
    transport.publish(snapshot('live', 'tab-local', [local, distant]))
    expect(service.getSnapshot().cursorPositions.remote).toEqual(distant.awareness.cursor)
    service.stop()

    const reducedTransport = collaboration(snapshot('live', 'tab-local', [local, remote]))
    const reducedService = createCollaborationService(docs.api, fakeWindow, animationClock(true).clock)
    reducedService.configure(reducedTransport.api)
    reducedService.start()
    const nearby = { ...remote, sequence: 2, awareness: { ...remote.awareness, cursor: { pageId: 'page-1', x: 25, y: 26 } } }
    reducedTransport.publish(snapshot('live', 'tab-local', [local, nearby]))
    expect(reducedService.getSnapshot().cursorPositions.remote).toEqual(nearby.awareness.cursor)
    reducedService.stop()
  })

  it('ignores a queued tick from an obsolete generation after stop', () => {
    const docs = documents()
    const local = participant('local', 'tab-local')
    const remote = participant('remote', 'tab-remote')
    const transport = collaboration(snapshot('live', 'tab-local', [local, remote]))
    const animation = animationClock()
    const service = createCollaborationService(docs.api, fakeWindow, animation.clock)
    service.configure(transport.api)
    service.start()
    transport.publish(snapshot('live', 'tab-local', [local, { ...remote, awareness: { ...remote.awareness, cursor: { pageId: 'page-1', x: 25, y: 26 } } }]))
    const handle = animation.handles()[0]!
    service.stop()
    animation.force(handle)
    expect(service.getSnapshot()).toMatchObject({ status: 'unavailable', cursorPositions: {} })
    expect(animation.cancelled.has(handle)).toBe(true)
  })

  it('does not let a stale generation callback replace the active generation timer', () => {
    const docs = documents()
    const local = participant('local', 'tab-local')
    const remote = participant('remote', 'tab-remote')
    const first = collaboration(snapshot('live', 'tab-local', [local, remote]))
    const animation = animationClock()
    const service = createCollaborationService(docs.api, fakeWindow, animation.clock)
    service.configure(first.api)
    service.start()
    first.publish(snapshot('live', 'tab-local', [local, { ...remote, awareness: { ...remote.awareness, cursor: { pageId: 'page-1', x: 25, y: 26 } } }]))
    const staleHandle = animation.handles()[0]!

    const secondRemote = { ...remote, awareness: { ...remote.awareness, cursor: { pageId: 'page-1', x: 100, y: 100 } } }
    const second = collaboration(snapshot('live', 'tab-local', [local, secondRemote]))
    service.configure(second.api)
    second.publish(snapshot('live', 'tab-local', [local, { ...secondRemote, awareness: { ...secondRemote.awareness, cursor: { pageId: 'page-1', x: 120, y: 120 } } }]))
    animation.force(staleHandle)
    expect(animation.flush()).toBe(true)
    expect(service.getSnapshot().cursorPositions.remote).toEqual({ pageId: 'page-1', x: 110, y: 110 })
    service.stop()
  })
})

describe('CLOUD-SYNC-READONLY-001 collaboration authority service', () => {
  it('keeps viewers read only through reconnecting status and never publishes awareness', () => {
    const docs = documents()
    const local = { ...participant('local', 'tab-local'), role: 'viewer' as const }
    const remote = participant('remote', 'tab-remote')
    const transport = collaboration(snapshot('read-only', 'tab-local', [local, remote], false))
    const service = createCollaborationService(docs.api, fakeWindow, animationClock().clock)
    service.configure(transport.api)
    service.start()
    expect(docs.get().readOnly).toBe(true)
    transport.publish({ ...snapshot('reconnecting', 'tab-local', [], false), localProfile: transport.api.getSnapshot().localProfile })
    expect(docs.get().readOnly).toBe(true)
    expect(transport.updates).toHaveLength(0)
    service.stop()
  })
})

describe('CLOUD-SYNC-LIFECYCLE-001 collaboration service resources', () => {
  it('exposes only wired recovery actions and delegates them to the active adapter', () => {
    const docs = documents()
    const transport = collaboration(snapshot('error', 'tab-local', []))
    const retry = vi.fn()
    const leave = vi.fn()
    const service = createCollaborationService(docs.api, fakeWindow, animationClock().clock)

    service.configure({ ...transport.api, retry, leave })
    expect(service.getSnapshot()).toMatchObject({ canRetry: true, canLeave: true })
    service.retry()
    service.leave()
    expect(retry).toHaveBeenCalledOnce()
    expect(leave).toHaveBeenCalledOnce()

    service.configure(transport.api)
    expect(service.getSnapshot()).toMatchObject({ canRetry: false, canLeave: false })
    service.stop()
  })

  it('ERROR-VISIBILITY-001 reports awareness failures and leaves the document usable', () => {
    const docs = documents()
    const local = participant('local', 'tab-local')
    const transport = collaboration(snapshot('live', 'tab-local', [local]))
    const failure = new Error('stale connection')
    const api: EditorCollaborationApi = { ...transport.api, updateAwareness: () => { throw failure } }
    const reportError = vi.fn()
    const service = createCollaborationService(docs.api, fakeWindow, animationClock().clock, reportError)

    service.configure(api)
    expect(() => service.start()).not.toThrow()
    expect(reportError).toHaveBeenCalledWith(failure, 'awareness')
    expect(docs.get().readOnly).toBe(false)
    service.stop()
  })

  it('releases replaced and stopped API, document, focus, blur, and animation resources', () => {
    const docs = documents()
    const browser = trackedWindow()
    const animation = animationClock()
    const local = participant('local', 'tab-local')
    const remote = participant('remote', 'tab-remote')
    const first = collaboration(snapshot('live', 'tab-local', [local, remote]))
    const second = collaboration(snapshot('live', 'tab-local', [local, remote]))
    const service = createCollaborationService(docs.api, browser.browser, animation.clock)

    service.configure(first.api)
    service.start()
    expect(first.listenerCount()).toBe(1)
    expect(docs.listenerCount()).toBe(1)
    expect(browser.listenerCount('focus')).toBe(1)
    expect(browser.listenerCount('blur')).toBe(1)

    first.publish(snapshot('live', 'tab-local', [local, { ...remote, sequence: 2, awareness: { ...remote.awareness, cursor: { pageId: 'page-1', x: 25, y: 26 } } }]))
    const replacedHandle = animation.handles().at(-1)!
    service.configure(second.api)
    expect(first.listenerCount()).toBe(0)
    expect(second.listenerCount()).toBe(1)
    expect(animation.cancelled.has(replacedHandle)).toBe(true)
    expect(docs.listenerCount()).toBe(1)
    expect(browser.listenerCount('focus')).toBe(1)
    expect(browser.listenerCount('blur')).toBe(1)

    second.publish(snapshot('live', 'tab-local', [local, { ...remote, sequence: 3, awareness: { ...remote.awareness, cursor: { pageId: 'page-1', x: 45, y: 46 } } }]))
    const stoppedHandle = animation.handles().at(-1)!
    service.stop()
    expect(second.listenerCount()).toBe(0)
    expect(docs.listenerCount()).toBe(0)
    expect(browser.listenerCount('focus')).toBe(0)
    expect(browser.listenerCount('blur')).toBe(0)
    expect(animation.cancelled.has(stoppedHandle)).toBe(true)

    service.stop()
    expect(second.listenerCount()).toBe(0)
    expect(docs.listenerCount()).toBe(0)
    expect(browser.listenerCount('focus')).toBe(0)
    expect(browser.listenerCount('blur')).toBe(0)
  })
})
