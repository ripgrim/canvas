import { acceptsChild, nodeChildDisplay } from '@canvas/repo-engine/file-document'
import type { FileDocument, NodeRelationship } from '@canvas/repo-engine/file-document'
import type { Atom } from '@canvas/repo-engine/contracts'
import type { FlowDragLane, FlowDragPresentation, FlowDragSlot, FlowDragTargetTopology, FlowDragTopologyAuthority } from '@canvas/sync-protocol'
import type { EditorCollaborationRemoteFlowEvent } from '../../capabilities'

export type RemoteFlowPresentationKey = Readonly<{
  presenceId: string
  clientId: string
  leaseId: string
  localClaimGeneration: number
  reservationGeneration: number
  gestureGeneration: number
}>

export type RemoteFlowPreviewBridge = Readonly<{
  publishRemoteFlowDragPresentation(key: RemoteFlowPresentationKey, presentation: FlowDragPresentation): boolean
  clearRemoteFlowDragPresentation(key: RemoteFlowPresentationKey, presentation: FlowDragPresentation, terminalSampleSequence: number): boolean
  clearAllRemoteFlowDragPresentations(): void
}>

export type RemoteFlowHudBridge = Readonly<{
  publishFlowDragPresentation(presentation: FlowDragPresentation): boolean
  clearFlowDragPresentation(identity: FlowDragPresentation['identity']): boolean
}>

type ActiveRemoteFlow = Readonly<{ key: RemoteFlowPresentationKey; presentation: FlowDragPresentation }>

const slotOf = (relationship: NodeRelationship): FlowDragSlot => Object.hasOwn(relationship, 'slot')
  ? Object.freeze({ presence: 'present' as const, value: relationship.slot! })
  : Object.freeze({ presence: 'absent' as const })

const sameSlot = (left: FlowDragSlot, right: FlowDragSlot) => left.presence === right.presence
  && (left.presence === 'absent' || right.presence === 'present' && left.value === right.value)

export function createEditorFlowTopologyAuthority(file: FileDocument, atoms: readonly Atom[], pageId: string): FlowDragTopologyAuthority | null {
  const page = file.pages.find(candidate => candidate.id === pageId)
  if (!page || file.nodes[page.rootNodeId]?.type !== 'root') return null
  const laneEntries = new Map<string, Array<{ nodeId: string; orderKey: string; slot: FlowDragSlot }>>()
  const children = new Map<string, string[]>()
  for (const [nodeId, relationship] of Object.entries(file.relationships)) {
    const slot = slotOf(relationship)
    const entries = laneEntries.get(relationship.parentId) ?? []
    entries.push({ nodeId, orderKey: relationship.orderKey, slot })
    laneEntries.set(relationship.parentId, entries)
    const childEntries = children.get(relationship.parentId) ?? []
    childEntries.push(nodeId)
    children.set(relationship.parentId, childEntries)
  }
  const lanes = new Map<string, readonly Readonly<{ nodeId: string; slot: FlowDragSlot }>[]>()
  const sourceIndexes = new Map<string, number>()
  for (const [parentId, entries] of laneEntries) {
    const bySlot: Array<{ slot: FlowDragSlot; entries: typeof entries }> = []
    for (const entry of entries) {
      let bucket = bySlot.find(candidate => sameSlot(candidate.slot, entry.slot))
      if (!bucket) { bucket = { slot: entry.slot, entries: [] }; bySlot.push(bucket) }
      bucket.entries.push(entry)
    }
    for (const bucket of bySlot) {
      const ordered = bucket.entries.sort((left, right) => left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : left.nodeId.localeCompare(right.nodeId))
      const lane = Object.freeze(ordered.map(entry => Object.freeze({ nodeId: entry.nodeId, slot: entry.slot })))
      lanes.set(`${parentId}\0${bucket.slot.presence === 'present' ? `present:${bucket.slot.value}` : 'absent'}`, lane)
      lane.forEach((entry, index) => sourceIndexes.set(entry.nodeId, index))
    }
  }
  const pageNodes = new Set<string>()
  const queue = [{ nodeId: page.rootNodeId, depth: 0 }]
  while (queue.length) {
    const current = queue.shift()!
    if (current.depth > 128 || pageNodes.has(current.nodeId)) return null
    pageNodes.add(current.nodeId)
    for (const childId of children.get(current.nodeId) ?? []) queue.push({ nodeId: childId, depth: current.depth + 1 })
  }
  const emptyLane = Object.freeze([]) as readonly Readonly<{ nodeId: string; slot: FlowDragSlot }>[]
  const laneNodes = (lane: FlowDragLane) => file.nodes[lane.parentId]
    ? lanes.get(`${lane.parentId}\0${lane.slot.presence === 'present' ? `present:${lane.slot.value}` : 'absent'}`) ?? emptyLane
    : null
  const targetInsideSource = (sourceNodeId: string, targetParentId: string) => {
    const seen = new Set<string>()
    let current: string | null = targetParentId
    while (current !== null) {
      if (seen.size >= 128 || seen.has(current)) return true
      if (current === sourceNodeId) return true
      if (current === page.rootNodeId) return false
      seen.add(current)
      current = file.relationships[current]?.parentId ?? null
    }
    return true
  }
  const source = (nodeId: string) => {
    const node = file.nodes[nodeId]
    const relationship = file.relationships[nodeId]
    if (!node || node.type === 'root' || !relationship || !pageNodes.has(nodeId)) return null
    const lane = Object.freeze({ parentId: relationship.parentId, slot: slotOf(relationship) })
    const sourceIndex = sourceIndexes.get(nodeId) ?? -1
    return sourceIndex < 0 ? null : Object.freeze({
      kind: node.type,
      relationship: Object.freeze({ parentId: relationship.parentId, orderKey: relationship.orderKey, slot: lane.slot }),
      sourceIndex,
    })
  }
  const acceptsTarget = (target: FlowDragTargetTopology) => {
    if (target.pageId !== pageId || target.pageRootId !== page.rootNodeId || target.targetLane.parentId === page.rootNodeId) return false
    const sourceNode = file.nodes[target.sourceNodeId]
    const authoritative = source(target.sourceNodeId)
    const parent = file.nodes[target.targetLane.parentId]
    if (!sourceNode || !authoritative || !parent || !pageNodes.has(target.targetLane.parentId)
      || targetInsideSource(target.sourceNodeId, target.targetLane.parentId)) return false
    const slot = target.targetLane.slot.presence === 'present' ? target.targetLane.slot.value : undefined
    if (!acceptsChild(parent, sourceNode, slot, atoms as Atom[])) return false
    if (parent.type === 'frame' && (target.targetLane.slot.presence !== 'absent' || nodeChildDisplay(parent) !== 'flex')) return false
    if (parent.type === 'component' && target.targetLane.slot.presence !== 'present') return false
    if (parent.type !== 'frame' && parent.type !== 'component') return false
    const targetNodes = laneNodes(target.targetLane)
    return Boolean(targetNodes && target.rawIndex <= targetNodes.length && target.semanticIndex <= targetNodes.length)
  }
  return Object.freeze({ fileId: file.fileId, fileRevision: file.revision, pageId, pageRootId: page.rootNodeId, source, acceptsTarget })
}

const remoteKey = (event: Extract<EditorCollaborationRemoteFlowEvent, { type: 'sample' }>): RemoteFlowPresentationKey => Object.freeze({
  presenceId: event.sample.presenceId,
  clientId: event.sample.clientId,
  leaseId: event.sample.leaseId,
  localClaimGeneration: event.sample.localClaimGeneration,
  reservationGeneration: event.sample.reservationGeneration,
  gestureGeneration: event.sample.presentation.identity.gestureGeneration,
})

const keyId = (key: RemoteFlowPresentationKey) => `${key.presenceId}\0${key.clientId}\0${key.leaseId}\0${key.localClaimGeneration}\0${key.reservationGeneration}\0${key.gestureGeneration}`

export function createFlowDragRelay(preview: RemoteFlowPreviewBridge, hud: RemoteFlowHudBridge) {
  const active = new Map<string, ActiveRemoteFlow>()
  const released = new Map<string, number>()
  return Object.freeze({
    receive(event: EditorCollaborationRemoteFlowEvent, localClientId: string | null): boolean {
      if (event.type === 'sample') {
        if (event.sample.clientId === localClientId) return false
        const key = remoteKey(event)
        const id = keyId(key)
        if (released.has(id)) return false
        const prior = active.get(id)
        const presentation = event.sample.presentation
        if (prior && presentation.identity.sampleSequence <= prior.presentation.identity.sampleSequence) return false
        const related = [...active.entries()].filter(([, entry]) => entry.key.presenceId === key.presenceId
          && entry.key.clientId === key.clientId && entry.key.leaseId === key.leaseId
          && entry.key.localClaimGeneration === key.localClaimGeneration
          && entry.presentation.identity.interactionId === presentation.identity.interactionId)
        if (related.some(([, entry]) => entry.key.reservationGeneration > key.reservationGeneration
          || entry.key.reservationGeneration === key.reservationGeneration && entry.key.gestureGeneration > key.gestureGeneration)) return false
        const entry = Object.freeze({ key, presentation })
        const previewAccepted = preview.publishRemoteFlowDragPresentation(key, presentation)
        const hudAccepted = hud.publishFlowDragPresentation(presentation)
        if (!previewAccepted && !hudAccepted) return false
        for (const [relatedId, relatedEntry] of related) {
          if (relatedId === id) continue
          active.delete(relatedId)
          released.set(relatedId, relatedEntry.presentation.identity.sampleSequence)
          preview.clearRemoteFlowDragPresentation(relatedEntry.key, relatedEntry.presentation, relatedEntry.presentation.identity.sampleSequence)
          hud.clearFlowDragPresentation(relatedEntry.presentation.identity)
        }
        active.set(id, entry)
        return true
      }
      if (event.release.clientId === localClientId) return false
      const matching = [...active.entries()].find(([, entry]) => entry.key.presenceId === event.release.presenceId
        && entry.key.clientId === event.release.clientId && entry.key.leaseId === event.release.leaseId
        && entry.key.localClaimGeneration === event.release.localClaimGeneration
        && entry.key.reservationGeneration === event.release.reservationGeneration
        && entry.presentation.identity.interactionId === event.release.interactionId)
      if (!matching || event.release.terminalSampleSequence < matching[1].presentation.identity.sampleSequence) return false
      active.delete(matching[0])
      released.set(matching[0], event.release.terminalSampleSequence)
      preview.clearRemoteFlowDragPresentation(matching[1].key, matching[1].presentation, event.release.terminalSampleSequence)
      hud.clearFlowDragPresentation(matching[1].presentation.identity)
      return true
    },
    clearAll() {
      for (const entry of active.values()) {
        preview.clearRemoteFlowDragPresentation(entry.key, entry.presentation, entry.presentation.identity.sampleSequence)
        hud.clearFlowDragPresentation(entry.presentation.identity)
      }
      active.clear()
      released.clear()
      preview.clearAllRemoteFlowDragPresentations()
    },
    size: () => active.size,
    hasState: () => active.size > 0 || released.size > 0,
  })
}
