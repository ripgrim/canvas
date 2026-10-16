import { ancestorsOf } from '@canvas/repo-engine/file-document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { floatingPortalContainer } from '../../design-system/floating-portal'
import { documentStore } from './document-store'

export type ComponentCreationRequest = Readonly<{
  sequence: number
  fileId: string
  nodeId: string
  container: HTMLElement | null
}>

let request: ComponentCreationRequest | null = null
let sequence = 0
const listeners = new Set<() => void>()

export function componentCreationCandidate(file: FileDocument | null, selection: readonly string[]): string | null {
  if (!file || selection.length !== 1) return null
  const nodeId = selection[0]!
  const node = file.nodes[nodeId]
  if (!node || node.type === 'root') return null
  if ([nodeId, ...ancestorsOf(file, nodeId)].some(candidate => Boolean(file.componentModel.instances[candidate]))) return null
  if (Object.values(file.componentModel.definitions).some(definition => definition.source.kind === 'canvas' && definition.source.masterRootId === nodeId)) return null
  return nodeId
}

function emit(next: ComponentCreationRequest | null) {
  request = next
  for (const listener of [...listeners]) listener()
}

export const componentCreationService = Object.freeze({
  getSnapshot: (): ComponentCreationRequest | null => request,
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  open: (target: EventTarget | null = null) => {
    const state = documentStore.getSnapshot()
    const nodeId = componentCreationCandidate(state.file, state.selection)
    if (!state.file || !nodeId || state.readOnly || state.blocked) return false
    const element = typeof HTMLElement !== 'undefined' && target instanceof HTMLElement ? target : null
    emit({ sequence: ++sequence, fileId: state.file.fileId, nodeId, container: floatingPortalContainer(element) })
    return true
  },
  close: () => emit(null),
})
