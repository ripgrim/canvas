import type { FlowDragLane, FlowDragPresentation, InteractionResultMessage } from '@canvas/sync-protocol'
import type { EditorCollaborationApi, EditorCollaborationFlowClaim, EditorCollaborationFlowOutcome, EditorCollaborationInteraction, EditorCollaborationParticipant, EditorCollaborationPoint, EditorCollaborationSnapshot, EditorCollaborationTransform, EditorPersistenceIntent } from '../../capabilities'
import type { FileCommand } from '@canvas/repo-engine/file-document'
import type { DocumentState } from '../editor/document-store'
import { documentStore } from '../editor/document-store'
import { canvasHudProjectionService } from '../editor/canvas-hud-projection-service'
import { createFlowDragRelay } from './flow-drag-relay'
import type { RemoteFlowPreviewBridge } from './flow-drag-relay'

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

export type LocalFlowClaimToken = Readonly<{
  kind: 'local-flow-claim'
  generation: number
  interactionId: string
  sourceNodeId: string
}>

export type LocalFlowAcquire = Readonly<{
  token: LocalFlowClaimToken
  result: Promise<EditorCollaborationFlowOutcome>
}>

type LocalFlowClaim = {
  readonly token: LocalFlowClaimToken
  readonly api: EditorCollaborationApi
  readonly apiEpoch: number
  readonly claim: EditorCollaborationFlowClaim
  confirmed: boolean
  leaseId: string | null
  reservationGeneration: number
  presentation: FlowDragPresentation
  terminal: Readonly<{ presentation: FlowDragPresentation; reason: 'committed' | 'cancelled' | 'failed' | 'disconnecting' }> | null
}

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
  let stopFlowResults: (() => void) | undefined
  let stopRemoteFlow: (() => void) | undefined
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
  let flowApiEpoch = 0
  let localFlowGeneration = 0
  let flowAuthorityPublication: Readonly<{
    api: EditorCollaborationApi
    file: DocumentState['file']
    atoms: DocumentState['atoms'] | null
    pageId: string | null
    pageRootId: string | null
    documentRevision: number | null
    layoutGeneration: number | null
  }> | null = null
  let remotePreview: RemoteFlowPreviewBridge | null = null
  const previewProxy: RemoteFlowPreviewBridge = Object.freeze({
    publishRemoteFlowDragPresentation: (key, presentation) => remotePreview?.publishRemoteFlowDragPresentation(key, presentation) ?? false,
    clearRemoteFlowDragPresentation: (key, presentation, sequence) => remotePreview?.clearRemoteFlowDragPresentation(key, presentation, sequence) ?? false,
    clearAllRemoteFlowDragPresentations: () => remotePreview?.clearAllRemoteFlowDragPresentations(),
  })
  const flowRelay = createFlowDragRelay(previewProxy, canvasHudProjectionService)
  const localFlowClaims = new Map<LocalFlowClaimToken, LocalFlowClaim>()
  const handledFlowResults = new Set<string>()
  const flowResultListeners = new Set<(result: InteractionResultMessage) => void>()
  const commitWaiters = new Map<string, Set<(allowed: boolean) => void>>()
  const listeners = new Set<() => void>()
  const followingListeners = new Set<() => void>()

  const clearFlowClaims = (invalidateApi = false) => {
    if (invalidateApi) flowApiEpoch += 1
    localFlowClaims.clear()
    handledFlowResults.clear()
  }
  const flowDenied = (code: Extract<EditorCollaborationFlowOutcome, { status: 'denied' }>['code']): EditorCollaborationFlowOutcome => Object.freeze({ status: 'denied', code })
  const flowGranted = (result: InteractionResultMessage): EditorCollaborationFlowOutcome => Object.freeze({ status: 'granted', result })
  const claimFor = (token: LocalFlowClaimToken) => localFlowClaims.get(token) ?? null
  const matchingClaim = (claim: LocalFlowClaim, apiEpoch = flowApiEpoch) => claim.api === api && claim.apiEpoch === apiEpoch && localFlowClaims.get(claim.token) === claim
  const resultMatchesClaim = (result: InteractionResultMessage, claim: LocalFlowClaim, action: InteractionResultMessage['action']) => result.action === action
    && result.pageId === claim.claim.pageId && result.interactionId === claim.claim.interactionId
    && result.localClaimGeneration === claim.claim.localClaimGeneration
  const settleFlowResult = (result: InteractionResultMessage) => {
    const resultKey = JSON.stringify(result)
    if (handledFlowResults.has(resultKey)) return
    handledFlowResults.add(resultKey)
    if (handledFlowResults.size > 512) handledFlowResults.delete(handledFlowResults.values().next().value!)
    for (const listener of flowResultListeners) listener(result)
    for (const [token, claim] of localFlowClaims) {
      if (claim.claim.localClaimGeneration !== result.localClaimGeneration || claim.claim.interactionId !== result.interactionId || claim.claim.pageId !== result.pageId) continue
      if (result.action === 'acquire' && result.status === 'denied' || result.action === 'release' && (result.status === 'released' || result.status === 'retained')) localFlowClaims.delete(token)
    }
  }
  const flowAuthority = () => {
    const state = documents.getSnapshot()
    if (!state.file || !state.pageId) return null
    const page = state.file.pages.find(candidate => candidate.id === state.pageId)
    return page ? Object.freeze({
      file: state.file,
      atoms: state.atoms,
      pageId: state.pageId,
      pageRootId: page.rootNodeId,
      documentRevision: state.file.revision,
      layoutGeneration: state.layoutGeneration,
    }) : null
  }
  const publishFlowAuthority = () => {
    const source = api
    if (!source?.updateFlowAuthority) { flowAuthorityPublication = null; return }
    const authority = snapshot.status === 'live' || snapshot.status === 'read-only' ? flowAuthority() : null
    const prior = flowAuthorityPublication
    if (!authority) {
      if (prior?.api === source && prior.file === null) return
      source.updateFlowAuthority(null)
      flowAuthorityPublication = Object.freeze({ api: source, file: null, atoms: null, pageId: null, pageRootId: null, documentRevision: null, layoutGeneration: null })
      return
    }
    if (prior?.api === source && prior.file === authority.file && prior.atoms === authority.atoms
      && prior.pageId === authority.pageId && prior.pageRootId === authority.pageRootId
      && prior.documentRevision === authority.documentRevision && prior.layoutGeneration === authority.layoutGeneration) return
    source.updateFlowAuthority(authority)
    flowAuthorityPublication = Object.freeze({ api: source, file: authority.file, atoms: authority.atoms, pageId: authority.pageId,
      pageRootId: authority.pageRootId, documentRevision: authority.documentRevision, layoutGeneration: authority.layoutGeneration })
  }

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
    if (next.status !== 'live' && next.status !== 'read-only') {
      if (localFlowClaims.size) clearFlowClaims()
      if (flowRelay.hasState()) flowRelay.clearAll()
    } else if (!next.canMutate && localFlowClaims.size) clearFlowClaims()
    if (localInteraction && (next.status !== 'live' || !next.canMutate)) clearInteraction(localInteraction.interactionId)
    const authoritativeLocal = next.participants.find(participant => participant.clientId === next.localClientId)
    localInteractionConfirmed ||= Boolean(localInteraction
      && authoritativeLocal?.awareness.interaction?.interactionId === localInteraction.interactionId)
    documents.setReadOnly(!next.canMutate)
    const followed = remoteIn(next, snapshot.followingPresenceId)
    const followingPresenceId = followTarget(followed, documents) ? snapshot.followingPresenceId : null
    const cursorPositions = reconcileCursors(next, followingPresenceId)
    publish(Object.freeze({ ...next, followingPresenceId, cursorPositions, canRetry: Boolean(api.retry), canLeave: Boolean(api.leave) }))
    publishFlowAuthority()
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
    publishFlowAuthority()
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
    if (api.interactionAwareness === false) return true
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
    const source = api
    const epoch = flowApiEpoch
    stopApi = api.subscribe(readApi)
    stopFlowResults = api.subscribeInteractionResults?.(result => {
      if (api !== source || epoch !== flowApiEpoch) return
      settleFlowResult(result)
    })
    stopRemoteFlow = api.subscribeRemoteFlow?.(event => {
      if (api !== source || epoch !== flowApiEpoch) return
      flowRelay.receive(event, snapshot.localClientId)
    })
    readApi()
    publishFlowAuthority()
  }
  const releaseFlowClaim = async (claim: LocalFlowClaim, terminalSampleSequence: number, reason: 'committed' | 'cancelled' | 'failed' | 'disconnecting'): Promise<EditorCollaborationFlowOutcome> => {
    if (!matchingClaim(claim) || !claim.confirmed || !claim.api.releaseFlow) return flowDenied('stale_room')
    try {
      const result = await claim.api.releaseFlow({ claim: claim.claim, terminalSampleSequence, reason })
      if (claim.api !== api || claim.apiEpoch !== flowApiEpoch || !resultMatchesClaim(result, claim, 'release')) return flowDenied('stale_room')
      settleFlowResult(result)
      return result.status === 'denied' ? flowDenied(result.denialCode ?? 'transport_failure') : flowGranted(result)
    } catch {
      return matchingClaim(claim) ? flowDenied('transport_failure') : flowDenied('stale_room')
    }
  }

  return Object.freeze({
    configure(next: EditorCollaborationApi | undefined) {
      clearInteraction()
      flowRelay.clearAll()
      clearFlowClaims(true)
      api?.updateFlowAuthority?.(null)
      flowAuthorityPublication = null
      stopApi?.()
      stopFlowResults?.()
      stopRemoteFlow?.()
      stopApi = undefined
      stopFlowResults = undefined
      stopRemoteFlow = undefined
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
      flowRelay.clearAll()
      clearFlowClaims(true)
      api?.updateFlowAuthority?.(null)
      flowAuthorityPublication = null
      stopApi?.()
      stopFlowResults?.()
      stopRemoteFlow?.()
      stopDocuments?.()
      stopApi = undefined
      stopFlowResults = undefined
      stopRemoteFlow = undefined
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
    bindRemoteFlowPreview(next: RemoteFlowPreviewBridge | null) {
      if (remotePreview === next) return
      flowRelay.clearAll()
      remotePreview = next
    },
    subscribeFlowResults(listener: (result: InteractionResultMessage) => void) { flowResultListeners.add(listener); return () => flowResultListeners.delete(listener) },
    acquireFlow(presentation: FlowDragPresentation, reuse?: LocalFlowClaimToken): LocalFlowAcquire {
      localFlowGeneration += 1
      const token = Object.freeze({ kind: 'local-flow-claim' as const, generation: localFlowGeneration,
        interactionId: presentation.identity.interactionId, sourceNodeId: presentation.original.documentNodeId })
      const source = api
      const epoch = flowApiEpoch
      if (!source?.acquireFlow || snapshot.status !== 'live' || !snapshot.canMutate) return Object.freeze({ token, result: Promise.resolve(flowDenied('read_only')) })
      const prior = reuse ? claimFor(reuse) : null
      if (reuse && (!prior || !matchingClaim(prior, epoch) || !prior.confirmed || !prior.leaseId
        || prior.claim.interactionId !== token.interactionId || prior.claim.sourceNodeId !== token.sourceNodeId)) {
        return Object.freeze({ token, result: Promise.resolve(flowDenied('stale_room')) })
      }
      let request
      try { request = source.acquireFlow({ presentation, ...(prior?.leaseId ? { leaseId: prior.leaseId } : {}) }) }
      catch { return Object.freeze({ token, result: Promise.resolve(flowDenied('transport_failure')) }) }
      const claim: LocalFlowClaim = { token, api: source, apiEpoch: epoch, claim: request.claim, confirmed: false, leaseId: null,
        reservationGeneration: 1, presentation, terminal: null }
      localFlowClaims.set(token, claim)
      const result = request.result.then(async response => {
        if (claim.api !== api || epoch !== flowApiEpoch || !resultMatchesClaim(response, claim, 'acquire')) return flowDenied('stale_room')
        settleFlowResult(response)
        if (response.status === 'denied' || response.leaseId === null) {
          localFlowClaims.delete(token)
          return flowDenied(response.denialCode ?? 'transport_failure')
        }
        if (!matchingClaim(claim, epoch)) return flowDenied('stale_room')
        claim.confirmed = true
        claim.leaseId = response.leaseId
        claim.reservationGeneration = response.reservationGeneration
        const terminal = claim.terminal
        if (terminal && terminal.reason !== 'committed') return releaseFlowClaim(claim, terminal.presentation.identity.sampleSequence, terminal.reason)
        return flowGranted(response)
      }).catch(() => {
        const current = matchingClaim(claim, epoch)
        if (current) localFlowClaims.delete(token)
        return current ? flowDenied('transport_failure') : flowDenied('stale_room')
      })
      return Object.freeze({ token, result })
    },
    async reserveFlow(token: LocalFlowClaimToken, targetLane: FlowDragLane, presentation: FlowDragPresentation): Promise<EditorCollaborationFlowOutcome> {
      const claim = claimFor(token)
      if (!claim || !matchingClaim(claim) || !claim.confirmed || !claim.api.reserveFlow || claim.terminal) return flowDenied('stale_room')
      try {
        const result = await claim.api.reserveFlow({ claim: claim.claim, targetLane, presentation })
        if (!matchingClaim(claim) || !resultMatchesClaim(result, claim, 'reserve')) return flowDenied('stale_room')
        settleFlowResult(result)
        if (result.status === 'denied') return flowDenied(result.denialCode ?? 'transport_failure')
        claim.reservationGeneration = result.reservationGeneration
        claim.presentation = presentation
        return flowGranted(result)
      } catch { return matchingClaim(claim) ? flowDenied('transport_failure') : flowDenied('stale_room') }
    },
    sampleFlow(token: LocalFlowClaimToken, presentation: FlowDragPresentation) {
      const claim = claimFor(token)
      if (!claim || !matchingClaim(claim) || !claim.confirmed || !claim.api.sampleFlow || claim.terminal) return false
      try { claim.api.sampleFlow({ claim: claim.claim, presentation }); claim.presentation = presentation; return true }
      catch { return false }
    },
    markFlowTerminal(token: LocalFlowClaimToken, presentation: FlowDragPresentation, reason: 'committed' | 'cancelled' | 'failed' | 'disconnecting') {
      const claim = claimFor(token)
      if (!claim || !matchingClaim(claim) || presentation.identity.interactionId !== claim.claim.interactionId
        || presentation.original.documentNodeId !== claim.claim.sourceNodeId || presentation.identity.sampleSequence < claim.presentation.identity.sampleSequence
        || presentation.retention.kind !== 'terminal-retained' || presentation.retention.terminalSampleSequence !== presentation.identity.sampleSequence) return false
      claim.presentation = presentation
      claim.terminal = Object.freeze({ presentation, reason })
      if (claim.confirmed && reason !== 'committed') void releaseFlowClaim(claim, presentation.identity.sampleSequence, reason)
      return true
    },
    releaseFlow(token: LocalFlowClaimToken, reason: 'committed' | 'cancelled' | 'failed' | 'disconnecting') {
      const claim = claimFor(token)
      return claim ? releaseFlowClaim(claim, claim.presentation.identity.sampleSequence, reason) : Promise.resolve(flowDenied('stale_room'))
    },
    flowPersistenceIntent(token: LocalFlowClaimToken, commands: readonly FileCommand[]): EditorPersistenceIntent | null {
      const claim = claimFor(token)
      const terminal = claim?.terminal
      if (!claim || !terminal || terminal.reason !== 'committed' || !claim.confirmed || !claim.leaseId || !matchingClaim(claim)) return null
      return Object.freeze({ kind: 'commands' as const, commands: Object.freeze([...commands]), flow: Object.freeze({ claim: claim.claim, terminalPresentation: terminal.presentation }) })
    },
    hasFlowClaim(token: LocalFlowClaimToken) { return localFlowClaims.has(token) },
    updateCursor(point: Readonly<{ x: number; y: number }>) {
      const pageId = documents.getSnapshot().pageId
      if (!api || snapshot.status !== 'live' || !snapshot.canMutate || !pageId) return
      try { api.updateAwareness({ cursor: { pageId, ...point } }) } catch (error) { reportError(error, 'awareness') }
    },
    beginInteraction(kind: EditorCollaborationInteraction['kind'], nodeIds: readonly string[]) {
      const pageId = documents.getSnapshot().pageId
      const uniqueNodeIds = Object.freeze([...new Set(nodeIds)])
      if (!pageId || !uniqueNodeIds.length) return null
      const localOnly = !api || api.interactionAwareness === false
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
      if (!api || api.interactionAwareness === false) return true
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
    hasInteraction(interactionId: string) { return localInteraction?.interactionId === interactionId },
    isNodeLocked(nodeId: string) { return remoteInteractions([nodeId]).length > 0 },
  })
}

export const collaborationService = createCollaborationService()
