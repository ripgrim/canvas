import { useSyncExternalStore } from 'react'
import { ancestorsOf, legacyPageDocument } from '@canvas/repo-engine/file-document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { ContextMenu } from '../../design-system/context-menu'
import type { ContextMenuAction } from '../../design-system/context-menu'
import { serializeComponentUsage } from './code-output'
import { documentStore as store } from './document-store'
import { duplicatePlan, frameSelectionPlan, layerOrderPlan, ungroupPlan } from './context-menu-commands'
import { measuredChildren } from './layout-measure'
import { sceneGeometry } from './scene-geometry'

type CopyBuffer = { fileId: string; pageId: string; nodeIds: string[] }
let copyBuffer: CopyBuffer | null = null

const reason = {
  empty: 'Select a layer first',
  paste: 'Copy layers in this file before pasting',
  tailwind: 'Tailwind export is not available for this source model',
  group: 'Groups are not represented by the current document model',
  componentCode: 'React code is available only for source-bound component instances',
}

const writeClipboard = (text: string) => { if (typeof navigator !== 'undefined') void navigator.clipboard.writeText(text) }
const action = (id: string, label: string, onSelect: (() => void) | undefined, options: Partial<ContextMenuAction> = {}): ContextMenuAction => ({ id, label, ...options, ...(onSelect ? { onSelect } : {}) })

function componentCode(file: FileDocument, pageId: string, selection: readonly string[], atoms: ReturnType<typeof store.getSnapshot>['atoms']): string | null {
  if (!selection.length || selection.some(id => file.nodes[id]?.type !== 'component')) return null
  const paths = Object.fromEntries(atoms.filter(atom => /\.(?:tsx?|jsx?)$/.test(atom.path) && !atom.path.includes('..') && !atom.path.includes('\\')).map(atom => [atom.componentId, './' + atom.path.replace(/\.(?:tsx?|jsx?)$/, '')]))
  try { return serializeComponentUsage(legacyPageDocument(file, pageId), atoms, { moduleSpecifiers: paths, rootIds: [...selection] }).code }
  catch { return null }
}

export function NodeContextMenu({ position, onClose }: { position: { x: number; y: number }; onClose: () => void }) {
  const state = useSyncExternalStore(store.subscribe, store.getViewSnapshot, store.getViewSnapshot)
  const file = state.file
  const pageId = state.pageId
  if (!file || !pageId) return null
  const selection = state.selection.filter(id => Boolean(file.nodes[id]))
  const first = selection[0]
  const parent = first ? ancestorsOf(file, first)[0] : undefined
  const children = selection.flatMap(id => Object.keys(file.relationships).filter(candidate => file.relationships[candidate]?.parentId === id))
  const bufferValid = Boolean(copyBuffer && copyBuffer.fileId === file.fileId && copyBuffer.pageId === pageId && copyBuffer.nodeIds.every(id => Boolean(file.nodes[id])))
  const code = componentCode(file, pageId, selection, state.atoms)
  const order = (direction: Parameters<typeof layerOrderPlan>[2]) => {
    const commands = layerOrderPlan(file, selection, direction)
    if (commands.length) store.commands.executeBatch(commands)
  }
  const paste = (onTop: boolean) => {
    if (!copyBuffer || copyBuffer.fileId !== file.fileId || copyBuffer.pageId !== pageId) return
    const plan = duplicatePlan(file, copyBuffer.nodeIds, () => crypto.randomUUID(), onTop)
    store.commands.executeBatch(plan.commands, plan.selection)
  }
  const copyLink = () => {
    const url = new URL(window.location.href)
    url.searchParams.set('pageId', pageId)
    if (first) url.searchParams.set('nodeId', first)
    writeClipboard(url.toString())
  }
  const selectedComponents = selection.length > 0 && selection.every(id => file.nodes[id]?.type === 'component')
  const isFlex = selectedComponents && selection.every(id => file.nodes[id]?.type === 'component' && file.nodes[id].layout?.container?.display === 'flex')
  const flex = (display: 'flex' | 'block') => {
    const geometry = sceneGeometry.getSnapshot()
    const measured = Object.fromEntries(selection.map(id => [id, measuredChildren(file, geometry, id)]))
    store.commands.layout.setDisplay(display, selection, measured)
  }
  const frame = frameSelectionPlan(file, pageId, selection, () => crypto.randomUUID())
  const ungroup = ungroupPlan(file, selection)
  const groups: ContextMenuAction[][] = [
    [
      action('select-parent', 'Select parent', parent && file.nodes[parent]?.type !== 'root' ? () => store.select(parent) : undefined, { disabled: !parent || file.nodes[parent]?.type === 'root' }),
      action('select-children', 'Select children', children.length ? () => store.selectMany(children) : undefined, { shortcut: 'Enter', disabled: !children.length }),
    ],
    [
      action('copy', 'Copy', selection.length ? () => { copyBuffer = { fileId: file.fileId, pageId, nodeIds: [...selection] } } : undefined, { shortcut: 'Ctrl+C', disabled: !selection.length, ...(!selection.length ? { reason: reason.empty } : {}) }),
      action('copy-link', 'Copy link', first ? copyLink : undefined, { disabled: !first }),
      action('copy-as', 'Copy as…', undefined, { children: [
        action('copy-react', 'Copy as React code', code ? () => writeClipboard(code) : undefined, { shortcut: 'Alt+R', disabled: !code, ...(!code ? { reason: reason.componentCode } : {}) }),
        action('copy-tailwind', 'Copy as Tailwind', undefined, { shortcut: 'Alt+T', disabled: true, reason: reason.tailwind }),
      ] }),
    ],
    [
      action('paste', 'Paste', bufferValid ? () => paste(false) : undefined, { shortcut: 'Ctrl+V', disabled: !bufferValid, ...(!bufferValid ? { reason: reason.paste } : {}) }),
      action('paste-on-top', 'Paste on top', bufferValid ? () => paste(true) : undefined, { shortcut: 'Ctrl+Shift+V', disabled: !bufferValid, ...(!bufferValid ? { reason: reason.paste } : {}) }),
      action('duplicate', 'Duplicate', selection.length ? () => store.commands.duplicate() : undefined, { shortcut: 'Ctrl+D', disabled: !selection.length }),
    ],
    [
      action('frame', 'Frame selection', frame ? () => store.commands.executeBatch(frame.commands, frame.selection) : undefined, { shortcut: 'Shift+F', disabled: !frame }),
      action('flex', isFlex ? 'Remove flex' : 'Add flex', selectedComponents ? () => flex(isFlex ? 'block' : 'flex') : undefined, { shortcut: 'Shift+Alt+A', disabled: !selectedComponents }),
      action('group', 'Group selection', undefined, { shortcut: 'Ctrl+G', disabled: true, reason: reason.group }),
      action('ungroup', 'Ungroup', ungroup ? () => store.commands.executeBatch(ungroup.commands, ungroup.selection) : undefined, { shortcut: 'Ctrl+Shift+G', disabled: !ungroup }),
    ],
    [
      action('front', 'Bring to front', () => order('front'), { shortcut: ']' }),
      action('back', 'Send to back', () => order('back'), { shortcut: '[' }),
      action('forward', 'Move forward', () => order('forward'), { shortcut: 'Ctrl+]' }),
      action('backward', 'Move backward', () => order('backward'), { shortcut: 'Ctrl+[' }),
    ],
  ]
  return <ContextMenu position={position} label="Layer actions" groups={groups} onClose={onClose} />
}
