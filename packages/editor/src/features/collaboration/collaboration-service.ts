import type { EditorCollaborationApi, EditorCollaborationInteraction, EditorCollaborationParticipant, EditorCollaborationPoint, EditorCollaborationSnapshot, EditorCollaborationTransform } from '../../capabilities'
import type { DocumentState } from '../editor/document-store'
import { documentStore } from '../editor/document-store'

export type CollaborationViewSnapshot = EditorCollaborationSnapshot & Readonly<{
  followingPresenceId: string | null
  cursorPositions: Readonly<Record<string, EditorCollaborationPoint>>
  canRetry: boolean
  canLeave: boolean
}>

export type CollaborationAnimationClock = Readonly<{
  schedule(callback: () => void): unknown
  cancel(handle: unknown): void
  reducedMotion(): boolean
}>

export type CollaborationErrorReporter = (error: unknown, operation: 'awareness') => void

const emptyPeople = Object.freeze([])
const emptyAgents = Object.freeze([])
const emptyPositions = Object.freeze({})
const unavailableSnapshot: CollaborationViewSnapshot = Object.freeze({
  status: 'unavailable', localClientId: null, localProfile: null, canMutate: false, canManageShare: false,
  participants: emptyPeople, agents: emptyAgents, error: null, followingPresenceId: null, cursorPositions: emptyPositions, canRetry: false, canLeave: false,
})

const sameCamera = (left: DocumentState['viewport'], right: NonNullable<EditorCollaborationParticipant['awareness']['camera']>) => left.x === right.x && left.y === right.y && left.zoom === right.zoom
const samePoint = (left: EditorCollaborationPoint, right: EditorCollaborationPoint) => left.pageId === right.pageId && left.x === right.x && left.y === right.y
const followTarget = (participant: EditorCollaborationParticipant | null, documents: Pick<typeof documentStore, 'getSnapshot'>) => {
  if (!participant) return null
  const { pageId, camera } = participant.awareness
  if (!pageId || !camera || camera.pageId !== pageId || !documents.getSnapshot().file?.pages.some(page => page.id === pageId)) return null
  return { pageId, camera } as const
}

const defaultClock: CollaborationAnimationClock = Object.freeze({
  schedule: callback => typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : setTimeout(callback, 16),
  cancel: handle => {
    if (typeof cancelAnimationFrame === 'function' && typeof handle === 'number') cancelAnimationFrame(handle)
    else clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
  reducedMotion: () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
})

const defaultErrorReporter: CollaborationErrorReporter = (error, operation) => {
  console.error(`Collaboration ${operation} update failed.`, error)
}

export function createCollaborationService(
  documents = documentStore,
  browser: Pick<Window, 'addEventListener' | 'removeEventListener' | 'document'> | null = typeof window === 'undefined' ? null : window,
  clock: CollaborationAnimationClock = defaultClock,
  reportError: CollaborationErrorReporter = defaultErrorReporter,
) {
  let api: EditorCollaborationApi | undefined
  let snapshot = unavailableSnapshot
  let stopApi: (() => void) | undefined
  let stopDocuments: (() => void) | undefined
  let running = false
  let applyingFollow = false
  let lastAwarenessKey = ''
  let animationHandle: unknown = null
  let animationEpoch = 0
  let cursorTargets: Readonly<Record<string, EditorCollaborationPoint>> = emptyPositions
  let lastDocumentPageId = documents.getSnapshot().pageId
  let lastDocumentViewport = documents.getSnapshot().viewport
  let localInteraction: EditorCollaborationInteraction | null = null
  let localInteractionConfirmed = false
  let localInteractionClaims = 0
  const commitWaiters = new Map<string, Set<(allowed: boolean) => void>>()
  const listeners = new Set<() => void>()
  const followingListeners = new Set<() => void>()

  const publish = (next: CollaborationViewSnapshot) => {
    if (Object.is(snapshot, next)) return
    const followingChanged = snapshot.followingPresenceId !== next.followingPresenceId
    snapshot = next
    for (const listener of listeners) listener()
    if (followingChanged) for (const listener of followingListeners) listener()
  }
  const settleCommitWaiters = (interactionId: string, allowed: boolean) => {
    const waiters = commitWaiters.get(interactionId)
    if (!waiters) return
    commitWaiters.delete(interactionId)
    for (const resolve of waiters) resolve(allowed)
  }
  const remoteIn = (source: Pick<EditorCollaborationSnapshot, 'participants' | 'localClientId'>, presenceId: string | null) => presenceId
    ? source.participants.find(participant => participant.presenceId === presenceId && participant.clientId !== source.localClientId) ?? null
    : null
  const cancelAnimation = () => {
    animationEpoch += 1
    if (animationHandle !== null) clock.cancel(animationHandle)
    animationHandle = null
  }
  const animationNeeded = (positions: Readonly<Record<string, EditorCollaborationPoint>>, targets: Readonly<Record<string, EditorCollaborationPoint>>) => Object.entries(targets).some(([presenceId, target]) => {
    const current = positions[presenceId]
    return current && !samePoint(current, target)
  })
  const scheduleAnimation = () => {
    if (animationHandle !== null || !animationNeeded(snapshot.cursorPositions, cursorTargets)) return
    const epoch = animationEpoch
    const handle = clock.schedule(() => {
      if (animationHandle !== handle) return
      animationHandle = null
      if (epoch !== animationEpoch || !running) return
      let moving = false
      const positions: Record<string, EditorCollaborationPoint> = {}
      for (const [presenceId, target] of Object.entries(cursorTargets)) {
        const current = snapshot.cursorPositions[presenceId] ?? target
        if (current.pageId !== target.pageId || clock.reducedMotion()) { positions[presenceId] = target; continue }
        const dx = target.x - current.x
        const dy = target.y - current.y
        if (Math.abs(dx) <= 0.25 && Math.abs(dy) <= 0.25) { positions[presenceId] = target; continue }
        positions[presenceId] = Object.freeze({ pageId: target.pageId, x: current.x + dx / 2, y: current.y + dy / 2 })
        moving = true
      }
      const cursorPositions = Object.freeze(positions)
      if (Object.keys(cursorPositions).some(key => !samePoint(cursorPositions[key]!, snapshot.cursorPositions[key]!))) publish(Object.freeze({ ...snapshot, cursorPositions }))
      if (moving) scheduleAnimation()
    })
    animationHandle = handle
  }
  const reconcileCursors = (next: EditorCollaborationSnapshot, followingPresenceId: string | null) => {
    const positions: Record<string, EditorCollaborationPoint> = {}
    const targets: Record<string, EditorCollaborationPoint> = {}
    for (const participant of next.participants) {
      const target = participant.awareness.cursor
      if (!target || participant.clientId === next.localClientId) continue
      targets[participant.presenceId] = Object.freeze({ ...target })
      const current = snapshot.cursorPositions[participant.presenceId]
      const previousTarget = cursorTargets[participant.presenceId] ?? current
      const snap = !current || !previousTarget || current.pageId !== target.pageId || previousTarget.pageId !== target.pageId || followingPresenceId === participant.presenceId || clock.reducedMotion() || Math.abs(target.x - previousTarget.x) > 1_000 || Math.abs(target.y - previousTarget.y) > 1_000
      positions[participant.presenceId] = snap ? targets[participant.presenceId]! : current
    }
    cursorTargets = Object.freeze(targets)
    return Object.freeze(positions)
  }
  const applyFollow = (participant: EditorCollaborationParticipant) => {
    const target = followTarget(participant, documents)
    if (!target) return false
    applyingFollow = true
    try {
      const state = documents.getSnapshot()
      if (state.pageId !== target.pageId) documents.setPage(target.pageId)
      if (!sameCamera(documents.getSnapshot().viewport, target.camera)) documents.setViewport({ x: target.camera.x, y: target.camera.y, zoom: target.camera.zoom })
    } finally { applyingFollow = false }
    return true
  }
  const sendAwareness = (state = documents.getSnapshot()) => {
    if (!api || snapshot.status !== 'live' || !snapshot.canMutate || !state.pageId) return
    const patch = {
      pageId: state.pageId,
      focused: browser?.document.hasFocus() ?? true,
      selection: { pageId: state.pageId, nodeIds: Object.freeze([...state.selection]) },
      camera: { pageId: state.pageId, x: state.viewport.x, y: state.viewport.y, zoom: state.viewport.zoom },
    } as const
    const key = JSON.stringify(patch)
    if (key === lastAwarenessKey) return
    lastAwarenessKey = key
    try { api.updateAwareness(patch) } catch (error) { lastAwarenessKey = ''; reportError(error, 'awareness') }
  }
  const readApi = () => {
    if (!api) { documents.setReadOnly(false); publish(unavailableSnapshot); return }
    const next = api.getSnapshot()
    const authoritativeLocal = next.participants.find(participant => participant.clientId === next.localClientId)
    localInteractionConfirmed ||= Boolean(localInteraction
      && authoritativeLocal?.awareness.interaction?.interactionId === localInteraction.interactionId)
    documents.setReadOnly(!next.canMutate)
    const followed = remoteIn(next, snapshot.followingPresenceId)
    const followingPresenceId = followTarget(followed, documents) ? snapshot.followingPresenceId : null
    const cursorPositions = reconcileCursors(next, followingPresenceId)
    publish(Object.freeze({ ...next, followingPresenceId, cursorPositions, canRetry: Boolean(api.retry), canLeave: Boolean(api.leave) }))
    if (localInteraction) {
      if (localInteractionConfirmed) settleCommitWaiters(localInteraction.interactionId, true)
      else if (remoteInteractions(localInteraction.nodeIds).length > 0) settleCommitWaiters(localInteraction.interactionId, false)
    }
    const current = remoteIn(snapshot, followingPresenceId)
    if (current) applyFollow(current)
    sendAwareness()
    scheduleAnimation()
  }
  const documentChanged = () => {
    const state = documents.getSnapshot()
    const cameraCommand = state.pageId !== lastDocumentPageId || state.viewport !== lastDocumentViewport
    lastDocumentPageId = state.pageId
    lastDocumentViewport = state.viewport
    if (applyingFollow) return
    if (snapshot.followingPresenceId && cameraCommand) publish(Object.freeze({ ...snapshot, followingPresenceId: null }))
    sendAwareness(state)
  }
  const focusChanged = () => {
    if (!api || snapshot.status !== 'live' || !snapshot.canMutate) return
    try { api.updateAwareness({ focused: browser?.document.hasFocus() ?? true }) } catch (error) { reportError(error, 'awareness') }
  }
  const remoteInteractions = (nodeIds: readonly string[]) => {
    const ids = new Set(nodeIds)
    return snapshot.participants.filter(participant => participant.clientId !== snapshot.localClientId && participant.awareness.interaction?.nodeIds.some(nodeId => ids.has(nodeId)))
  }
  const publishInteraction = (interaction: EditorCollaborationInteraction | null) => {
    if (!api || snapshot.status !== 'live' || !snapshot.canMutate) return false
    const pageId = interaction?.pageId ?? documents.getSnapshot().pageId
    if (!pageId) return false
    try { api.updateAwareness({ pageId, interaction }, { immediate: true }); return true }
    catch (error) { reportError(error, 'awareness'); return false }
  }
  const clearInteraction = (expectedInteractionId?: string) => {
    if (!localInteraction) return
    if (expectedInteractionId && localInteraction.interactionId !== expectedInteractionId) return
    const releasedInteractionId = localInteraction.interactionId
    localInteraction = null
    localInteractionConfirmed = false
    localInteractionClaims = 0
    settleCommitWaiters(releasedInteractionId, false)
    publishInteraction(null)
  }
  const releaseInteraction = (expectedInteractionId?: string) => {
    if (!localInteraction) return
    if (expectedInteractionId && localInteraction.interactionId !== expectedInteractionId) return
    if (localInteractionClaims > 1) { localInteractionClaims -= 1; return }
    clearInteraction(expectedInteractionId)
  }
  const bindApi = () => {
    if (!api || stopApi) return
    stopApi = api.subscribe(readApi)
    readApi()
  }

  return Object.freeze({
    configure(next: EditorCollaborationApi | undefined) {
      clearInteraction()
      stopApi?.()
      stopApi = undefined
      cancelAnimation()
      api = next
      lastAwarenessKey = ''
      cursorTargets = emptyPositions
      localInteraction = null
      localInteractionConfirmed = false
      localInteractionClaims = 0
      const base = next?.getSnapshot()
      documents.setReadOnly(base ? !base.canMutate : false)
      publish(base ? Object.freeze({ ...base, followingPresenceId: null, cursorPositions: emptyPositions, canRetry: Boolean(next?.retry), canLeave: Boolean(next?.leave) }) : unavailableSnapshot)
      if (running) bindApi()
    },
    start() {
      if (running) return
      running = true
      lastDocumentPageId = documents.getSnapshot().pageId
      lastDocumentViewport = documents.getSnapshot().viewport
      stopDocuments = documents.subscribe(documentChanged)
      browser?.addEventListener('focus', focusChanged)
      browser?.addEventListener('blur', focusChanged)
      bindApi()
      sendAwareness()
    },
    stop() {
      if (!running && !api) return
      running = false
      clearInteraction()
      stopApi?.()
      stopDocuments?.()
      stopApi = undefined
      stopDocuments = undefined
      browser?.removeEventListener('focus', focusChanged)
      browser?.removeEventListener('blur', focusChanged)
      cancelAnimation()
      api = undefined
      lastAwarenessKey = ''
      cursorTargets = emptyPositions
      localInteraction = null
      localInteractionConfirmed = false
      localInteractionClaims = 0
      documents.setReadOnly(false)
      publish(unavailableSnapshot)
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => snapshot,
    subscribeFollowing(listener: () => void) { followingListeners.add(listener); return () => followingListeners.delete(listener) },
    getFollowingSnapshot: () => snapshot.followingPresenceId,
    follow(presenceId: string) {
      const participant = remoteIn(snapshot, presenceId)
      if (!followTarget(participant, documents)) return false
      publish(Object.freeze({ ...snapshot, followingPresenceId: presenceId, cursorPositions: reconcileCursors(snapshot, presenceId) }))
      if (applyFollow(participant!)) return true
      publish(Object.freeze({ ...snapshot, followingPresenceId: null }))
      return false
    },
    stopFollowing() {
      if (!snapshot.followingPresenceId) return
      publish(Object.freeze({ ...snapshot, followingPresenceId: null }))
    },
    retry() { api?.retry?.() },
    leave() { api?.leave?.() },
    updateCursor(point: Readonly<{ x: number; y: number }>) {
      const pageId = documents.getSnapshot().pageId
      if (!api || snapshot.status !== 'live' || !snapshot.canMutate || !pageId) return
      try { api.updateAwareness({ cursor: { pageId, ...point } }) } catch (error) { reportError(error, 'awareness') }
    },
    beginInteraction(kind: EditorCollaborationInteraction['kind'], nodeIds: readonly string[]) {
      const pageId = documents.getSnapshot().pageId
      const uniqueNodeIds = Object.freeze([...new Set(nodeIds)])
      if (!pageId || !uniqueNodeIds.length) return null
      const localOnly = !api
      if (localInteraction) {
        const sameNodes = localInteraction.nodeIds.length === uniqueNodeIds.length && uniqueNodeIds.every(nodeId => localInteraction?.nodeIds.includes(nodeId))
        if (!localInteractionConfirmed || localInteraction.pageId !== pageId || localInteraction.kind !== kind || !sameNodes || remoteInteractions(uniqueNodeIds).length) return null
        localInteraction = Object.freeze({ ...localInteraction, transforms: Object.freeze([]) })
        localInteractionClaims += 1
        if (localOnly) return localInteraction.interactionId
        if (publishInteraction(localInteraction)) return localInteraction.interactionId
        clearInteraction(localInteraction.interactionId)
        return null
      }
      if (remoteInteractions(uniqueNodeIds).length) return null
      localInteraction = Object.freeze({ interactionId: crypto.randomUUID(), pageId, kind, nodeIds: uniqueNodeIds, transforms: Object.freeze([]) })
      localInteractionConfirmed = localOnly
      localInteractionClaims = 1
      if (localOnly) return localInteraction.interactionId
      if (publishInteraction(localInteraction)) return localInteraction.interactionId
      localInteraction = null
      localInteractionClaims = 0
      return null
    },
    updateInteraction(interactionId: string, transforms: readonly EditorCollaborationTransform[]) {
      if (!localInteraction || localInteraction.interactionId !== interactionId) return false
      if (remoteInteractions(localInteraction.nodeIds).length > 0) { clearInteraction(); return false }
      localInteraction = Object.freeze({ ...localInteraction, transforms: Object.freeze(transforms.map(transform => Object.freeze({ ...transform }))) })
      if (!api) return true
      if (publishInteraction(localInteraction)) return true
      clearInteraction()
      return false
    },
    canCommitInteraction(interactionId: string) {
      return Boolean(localInteraction?.interactionId === interactionId && localInteractionConfirmed && remoteInteractions(localInteraction.nodeIds).length === 0)
    },
    waitForCommitInteraction(interactionId: string) {
      if (localInteraction?.interactionId !== interactionId) return Promise.resolve(false)
      if (localInteractionConfirmed && remoteInteractions(localInteraction.nodeIds).length === 0) return Promise.resolve(true)
      return new Promise<boolean>(resolve => {
        const waiters = commitWaiters.get(interactionId) ?? new Set<(allowed: boolean) => void>()
        waiters.add(resolve)
        commitWaiters.set(interactionId, waiters)
      })
    },
    endInteraction: releaseInteraction,
    isNodeLocked(nodeId: string) { return remoteInteractions([nodeId]).length > 0 },
  })
}

export const collaborationService = createCollaborationService()
