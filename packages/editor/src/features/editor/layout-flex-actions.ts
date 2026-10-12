import { ancestorsOf, descendantsOf, nodeChildDisplay } from '@canvas/repo-engine/file-document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { DisplayMeasurement } from './display-conversion'
import { canvasGestures } from './canvas-gestures'
import { documentStore } from './document-store'
import { measuredChildren, paperDirectAddGeometry } from './layout-measure'
import { sceneGeometry } from './scene-geometry'
import { editorStore } from './store'

export type PaperFlexClassification = null | 'add-flex-to-node' | 'wrap-in-flex' | 'remove-flex' | 'wrap-in-flex-or-remove-flex'
export type PaperFlexAction = Exclude<PaperFlexClassification, null | 'wrap-in-flex-or-remove-flex'>
export type PaperFlexActionCandidate = Readonly<{ action: PaperFlexAction; targetIds: readonly string[] }>
export type PaperFlexActionInput = Readonly<{ file: FileDocument | null; selection: readonly string[]; readOnly: boolean; pointerBusy: boolean }>

export const paperFlexActionCopy = {
  add: 'Add flex needs current canvas measurements. Wait for the canvas to finish updating, then try again.',
  wrap: 'Wrap needs current canvas measurements. Wait for the canvas to finish updating, then try again.',
  remove: 'Remove flex needs current canvas measurements. Wait for the canvas to finish updating, then try again.',
  changed: 'The document or selection changed before Flex could be applied. Try again.',
} as const

const unique = (ids: readonly string[]) => [...new Set(ids)]
const isContainer = (node: FileDocument['nodes'][string] | undefined) => node?.type === 'frame' || node?.type === 'component'
const isFlexContainer = (node: FileDocument['nodes'][string] | undefined) => Boolean(isContainer(node) && nodeChildDisplay(node!) === 'flex')
const sameIds = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((id, index) => id === right[index])

/** High-level Paper intent only. Structural support is deliberately derived separately below. */
export function classifyPaperFlexAction(input: PaperFlexActionInput): PaperFlexClassification {
  const { file, selection, readOnly, pointerBusy } = input
  if (!file || !selection.length || readOnly || pointerBusy) return null
  const ids = unique(selection)
  const nodes = ids.map(id => file.nodes[id])
  if (nodes.some(node => !node || node.type === 'root')) return null
  if (ids.length === 1) {
    const node = nodes[0]!
    if (isContainer(node)) return isFlexContainer(node) ? 'remove-flex' : 'add-flex-to-node'
    return 'wrap-in-flex'
  }
  return nodes.some(isFlexContainer) ? 'wrap-in-flex-or-remove-flex' : 'wrap-in-flex'
}

function canWrap(file: FileDocument, ids: readonly string[]): boolean {
  if (!ids.length) return false
  const selected = new Set(ids)
  const relationships = ids.map(id => file.relationships[id])
  if (ids.some(id => { const node = file.nodes[id]; return !node || node.type === 'root' || node.type === 'component' })) return false
  if (relationships.some(relationship => !relationship || relationship.slot !== undefined)) return false
  const parentIds = [...new Set(relationships.map(relationship => relationship!.parentId))]
  if (parentIds.some(parentId => { const parent = file.nodes[parentId]; return !parent || (parent.type !== 'root' && parent.type !== 'frame') })) return false
  return !ids.some(id => descendantsOf(file, id).some(descendant => selected.has(descendant)))
}

/** Supported executable actions. Unsupported topology is omitted rather than represented as a disabled action. */
export function paperFlexActionCandidates(input: PaperFlexActionInput): readonly PaperFlexActionCandidate[] {
  const classification = classifyPaperFlexAction(input)
  const file = input.file
  if (!classification || !file) return []
  const ids = unique(input.selection)
  const candidates: PaperFlexActionCandidate[] = []
  if (classification === 'add-flex-to-node') {
    const node = file.nodes[ids[0]!]
    const display = node ? nodeChildDisplay(node) : null
    if (node?.type === 'component' && (display === 'freeform' || display === 'block' || display === 'grid') || node?.type === 'frame' && display === 'freeform') candidates.push({ action: 'add-flex-to-node', targetIds: ids })
  }
  if ((classification === 'wrap-in-flex' || classification === 'wrap-in-flex-or-remove-flex') && canWrap(file, ids)) candidates.push({ action: 'wrap-in-flex', targetIds: ids })
  if (classification === 'remove-flex' || classification === 'wrap-in-flex-or-remove-flex') {
    const targetIds = ids.filter(id => isFlexContainer(file.nodes[id]))
    const selectedTargets = new Set(targetIds)
    const nested = targetIds.some(id => ancestorsOf(file, id).some(ancestor => selectedTargets.has(ancestor)))
    if (targetIds.length && !nested) candidates.push({ action: 'remove-flex', targetIds })
  }
  return candidates
}

export type PaperFlexExecutionResult = Readonly<{ status: 'written' | 'ineligible' | 'unavailable'; action: PaperFlexAction; message?: string }>

export function executePaperFlexAction(action: PaperFlexAction): PaperFlexExecutionResult {
  const captured = documentStore.getSnapshot()
  const capturedBusy = editorStore.getSnapshot().busy
  const file = captured.file
  const fileId = file?.fileId
  const revision = file?.revision
  const selection = [...captured.selection]
  const candidate = paperFlexActionCandidates({ file, selection, readOnly: captured.readOnly, pointerBusy: canvasGestures.active }).find(value => value.action === action)
  if (!file || capturedBusy !== null || !candidate) return { status: 'ineligible', action }
  const geometry = sceneGeometry.getSnapshot()

  let measured: Record<string, DisplayMeasurement> | null = null
  if (action === 'add-flex-to-node') {
    const id = candidate.targetIds[0]!
    const node = file.nodes[id]!
    const display = nodeChildDisplay(node)
    measured = display === 'freeform'
      ? { [id]: { boxes: null, flexInput: null, directAdd: paperDirectAddGeometry(file, geometry, id, captured.layoutGeneration) } }
      : { [id]: { boxes: measuredChildren(file, geometry, id), flexInput: null } }
    if (display === 'freeform' && measured[id]!.directAdd === null) return { status: 'unavailable', action, message: paperFlexActionCopy.add }
  }

  const latest = documentStore.getSnapshot()
  if (latest.file !== file || latest.file.fileId !== fileId || latest.file.revision !== revision || latest.layoutGeneration !== captured.layoutGeneration || latest.readOnly || editorStore.getSnapshot().busy !== capturedBusy || canvasGestures.active || !sameIds(latest.selection, selection)) {
    return { status: 'unavailable', action, message: paperFlexActionCopy.changed }
  }

  if (action === 'add-flex-to-node') return documentStore.commands.layout.setDisplay('flex', [...candidate.targetIds], measured!)
    ? { status: 'written', action }
    : { status: 'unavailable', action, message: paperFlexActionCopy.add }
  if (action === 'wrap-in-flex') {
    const result = documentStore.commands.layout.wrapSelection(geometry)
    return result.status === 'written' ? { status: 'written', action } : { status: 'unavailable', action, message: result.message }
  }
  const result = documentStore.commands.layout.removeFlexSelection(geometry, candidate.targetIds)
  return result.status === 'written' ? { status: 'written', action } : { status: 'unavailable', action, message: result.message.replace('Remove Flex', 'Remove flex') }
}

export const directAddFlexCopy = { unavailable: paperFlexActionCopy.add, nested: 'Add flex cannot convert both a container and one of its descendants at the same time.' } as const
export type DirectAddFlexAvailability = Readonly<{ status: 'eligible'; ids: readonly string[]; measured: Record<string, DisplayMeasurement> }> | Readonly<{ status: 'already-flex' | 'ineligible' }> | Readonly<{ status: 'unavailable'; message: string }>
export type DirectAddFlexResult = Readonly<{ status: 'written' | 'ineligible' | 'unavailable'; message?: string }>

function captureLegacyDirectAdd(): Readonly<{ availability: DirectAddFlexAvailability; file?: FileDocument; selection?: readonly string[]; layoutGeneration?: number }> {
  const state = documentStore.getSnapshot()
  const file = state.file
  const ids = [...state.selection]
  if (!file || !ids.length || state.readOnly || canvasGestures.active) return { availability: { status: 'ineligible' } }
  const nodes = ids.map(id => file.nodes[id])
  if (nodes.some(node => !isContainer(node))) return { availability: { status: 'ineligible' } }
  const displays = nodes.map(node => nodeChildDisplay(node!))
  if (displays.every(display => display === 'flex')) return { availability: { status: 'already-flex' } }
  if (!displays.every(display => display === 'freeform')) return { availability: { status: 'ineligible' } }
  const selected = new Set(ids)
  if (ids.some(id => ancestorsOf(file, id).some(ancestor => selected.has(ancestor)))) return { availability: { status: 'unavailable', message: directAddFlexCopy.nested } }
  const geometry = sceneGeometry.getSnapshot()
  const measured = Object.fromEntries(ids.map(id => [id, { boxes: null, flexInput: null, directAdd: paperDirectAddGeometry(file, geometry, id, state.layoutGeneration) }]))
  if (Object.values(measured).some(value => value.directAdd === null)) return { availability: { status: 'unavailable', message: directAddFlexCopy.unavailable } }
  return { availability: { status: 'eligible', ids, measured }, file, selection: ids, layoutGeneration: state.layoutGeneration }
}

export function directAddFlexAvailability(): DirectAddFlexAvailability {
  return captureLegacyDirectAdd().availability
}

export function directAddFlexToCurrentSelection(): DirectAddFlexResult {
  const captured = captureLegacyDirectAdd()
  if (captured.availability.status === 'unavailable') return captured.availability
  if (captured.availability.status !== 'eligible') return { status: 'ineligible' }
  const latest = documentStore.getSnapshot()
  if (!captured.file || latest.file !== captured.file || latest.file.fileId !== captured.file.fileId || latest.file.revision !== captured.file.revision || latest.layoutGeneration !== captured.layoutGeneration || latest.readOnly || canvasGestures.active || !captured.selection || !sameIds(latest.selection, captured.selection)) return { status: 'unavailable', message: directAddFlexCopy.unavailable }
  return documentStore.commands.layout.setDisplay('flex', [...captured.availability.ids], captured.availability.measured) ? { status: 'written' } : { status: 'unavailable', message: directAddFlexCopy.unavailable }
}
