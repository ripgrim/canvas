import { useSyncExternalStore } from 'react'
import { ancestorsOf, legacyPageDocument } from '@canvas/repo-engine/file-document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { ContextMenu } from '../../design-system/context-menu'
import type { ContextMenuAction } from '../../design-system/context-menu'
import { editorToast } from '../../design-system/toast-atoms'
import { serializeComponentUsage } from './code-output'
import { documentStore as store } from './document-store'
import { frameSelectionPlan, layerOrderPlan, ungroupPlan } from './context-menu-commands'
import { canvasGestures } from './canvas-gestures'
import { executePaperFlexAction, paperFlexActionCandidates, paperFlexActionCopy } from './layout-flex-actions'
import type { PaperFlexAction } from './layout-flex-actions'
import { canvasCopy as copy } from './canvas-copy'
import { componentCreationCandidate, componentCreationService } from './component-creation-service'
import { createInternalClipboardPayload } from './clipboard-internal'
import { encodeInternalClipboardPayload } from './clipboard-codec'
import { clipboardCopy } from './clipboard-copy'
import { sceneGeometry } from './scene-geometry'
import { captureInternalClipboardAssets, internalClipboardBuffer, publishInternalClipboard } from './clipboard-internal-buffer'

const reason = {
  empty: 'Select a layer first',
  paste: 'Copy layers before pasting',
  tailwind: 'Tailwind export is not available for this source model',
  componentCode: 'React code is available only for source-bound component instances',
}

const writeClipboard = (text: string) => { if (typeof navigator !== 'undefined') void navigator.clipboard.writeText(text) }
const action = (id: string, label: string, onSelect: ((target?: EventTarget | null) => void) | undefined, options: Partial<ContextMenuAction> = {}): ContextMenuAction => ({ id, label, ...options, ...(onSelect ? { onSelect } : {}) })

const flexPresentation: Record<PaperFlexAction, Readonly<{ id: string; label: string; shortcut: string; errorTitle: string }>> = {
  'add-flex-to-node': { id: 'flex-add', label: 'Add flex layout', shortcut: 'Shift+A', errorTitle: "Couldn't add flex" },
  'wrap-in-flex': { id: 'flex-wrap', label: 'Wrap in flex', shortcut: 'Shift+A', errorTitle: "Couldn't wrap in flex" },
  'remove-flex': { id: 'flex-remove', label: 'Remove flex', shortcut: 'Shift+Alt+A', errorTitle: "Couldn't remove flex" },
}

/** Availability is captured for rendering only. Selection and document authority are re-read on activation. */
export function flexContextMenuActions(options: Readonly<{ closeMenu?: () => void; reportUnavailable?: (title: string, message: string) => void }> = {}): ContextMenuAction[] {
  const state = store.getSnapshot()
  const candidates = paperFlexActionCandidates({ file: state.file, selection: state.selection, readOnly: state.readOnly, pointerBusy: canvasGestures.active })
  return candidates.map(candidate => {
    const presentation = flexPresentation[candidate.action]
    return action(presentation.id, presentation.label, () => {
      try {
        const result = executePaperFlexAction(candidate.action)
        if (result.status !== 'written') (options.reportUnavailable ?? editorToast.error)(presentation.errorTitle, result.message ?? paperFlexActionCopy.changed)
      } finally { options.closeMenu?.() }
    }, { shortcut: presentation.shortcut })
  })
}

export function layoutContextMenuGroup(frame: ContextMenuAction, flex: readonly ContextMenuAction[], ungroup: ContextMenuAction): ContextMenuAction[] {
  return [frame, ...flex, ungroup]
}

function componentCode(file: FileDocument, pageId: string, selection: readonly string[], atoms: ReturnType<typeof store.getSnapshot>['atoms']): string | null {
  if (!selection.length || selection.some(id => file.nodes[id]?.type !== 'component')) return null
  const paths = Object.fromEntries(atoms.filter(atom => /\.(?:tsx?|jsx?)$/.test(atom.path) && !atom.path.includes('..') && !atom.path.includes('\\')).map(atom => [atom.componentId, './' + atom.path.replace(/\.(?:tsx?|jsx?)$/, '')]))
  try { return serializeComponentUsage(legacyPageDocument(file, pageId), atoms, { moduleSpecifiers: paths, rootIds: [...selection] }).code }
  catch { return null }
}

export function NodeContextMenu({ position, onClose, onRename }: { position: { x: number; y: number }; onClose: () => void; onRename?: (nodeId: string) => void }) {
  const state = useSyncExternalStore(store.subscribe, store.getViewSnapshot, store.getViewSnapshot)
  const file = state.file
  const pageId = state.pageId
  if (!file || !pageId || state.readOnly) return null
  const selection = state.selection.filter(id => Boolean(file.nodes[id]))
  const first = selection[0]
  const firstNode = first ? file.nodes[first] : undefined
  const renameKind = firstNode?.type === 'component' ? firstNode.exportName : firstNode?.type ?? 'layer'
  const parent = first ? ancestorsOf(file, first)[0] : undefined
  const children = selection.flatMap(id => Object.keys(file.relationships).filter(candidate => file.relationships[candidate]?.parentId === id))
  const bufferValid = Boolean(internalClipboardBuffer.get())
  const code = componentCode(file, pageId, selection, state.atoms)
  const componentCandidate = componentCreationCandidate(file, selection)
  const order = (direction: Parameters<typeof layerOrderPlan>[2]) => {
    const commands = layerOrderPlan(file, selection, direction)
    if (commands.length) store.commands.executeBatch(commands)
  }
  const paste = (onTop: boolean) => {
    const current = store.getSnapshot()
    const entry = internalClipboardBuffer.get()
    if (!entry || !current.file || !current.pageId || current.readOnly) return
    void store.commands.assets.insertInternalClipboard(entry.payload, entry.assets, onTop ? { offset: { x: 0, y: 0 } } : {}).then(result => {
      if (!result.inserted.length) editorToast.error(clipboardCopy.pasteFailed, result.error ?? clipboardCopy.internalRejected)
    }, error => editorToast.error(clipboardCopy.pasteFailed, error instanceof Error ? error.message : clipboardCopy.internalRejected))
  }
  const replace = () => {
    const current = store.getSnapshot()
    const entry = internalClipboardBuffer.get()
    if (!entry || !current.file || !current.pageId || current.readOnly || !current.selection.length) return
    const geometry = sceneGeometry.getSnapshot()
    void store.commands.assets.insertInternalClipboard(entry.payload, entry.assets, {}, {
      documentRevision: geometry.documentRevision,
      layoutGeneration: geometry.layoutGeneration,
      expectedLayoutGeneration: current.layoutGeneration,
      nodes: geometry.nodes,
    }).then(result => {
      if (!result.inserted.length) editorToast.error(clipboardCopy.pasteFailed, result.error ?? clipboardCopy.replaceRejected)
    }, error => editorToast.error(clipboardCopy.pasteFailed, error instanceof Error ? error.message : clipboardCopy.replaceRejected))
  }
  const copySelection = () => {
    const current = store.getSnapshot()
    if (!current.file || !current.pageId || !current.selection.length) return
    try {
      const payload = createInternalClipboardPayload(current.file, current.pageId, current.selection, current.atoms)
      const fallback = payload.roots.map(id => {
        const node = payload.nodes[id]
        return node && node.type !== 'root' ? node.name : 'Layer'
      }).join(', ')
      const value = encodeInternalClipboardPayload(payload, fallback, current.atoms)
      internalClipboardBuffer.remember(payload, value, captureInternalClipboardAssets(payload, store.assetPreview))
      void publishInternalClipboard(value).then(written => { if (!written) editorToast.error(clipboardCopy.copyFailed, clipboardCopy.systemClipboardDenied) })
    }
    catch (error) { editorToast.error(clipboardCopy.copyFailed, error instanceof Error ? error.message : clipboardCopy.copyRejected) }
  }
  let closed = false
  const closeMenu = () => { if (!closed) { closed = true; onClose() } }
  const copyLink = () => {
    const url = new URL(window.location.href)
    url.searchParams.set('pageId', pageId)
    if (first) url.searchParams.set('nodeId', first)
    writeClipboard(url.toString())
  }
  const frame = frameSelectionPlan(file, pageId, selection, () => crypto.randomUUID())
  const ungroup = ungroupPlan(file, selection)
  const flex = flexContextMenuActions({ closeMenu })
  const groups: ContextMenuAction[][] = [
    [
      action('rename', copy.renameType(renameKind), first && selection.length === 1 ? () => { if (onRename) onRename(first); else store.setRenaming(first) } : undefined, { shortcut: 'F2', disabled: !first || selection.length !== 1, ...(!first || selection.length !== 1 ? { reason: 'Select one layer to rename it' } : {}) }),
      ...(componentCandidate ? [action('create-component', 'Create component', target => { componentCreationService.open(target) })] : []),
    ],
    [
      action('select-parent', 'Select parent', parent && file.nodes[parent]?.type !== 'root' ? () => store.select(parent) : undefined, { disabled: !parent || file.nodes[parent]?.type === 'root' }),
      action('select-children', 'Select children', children.length ? () => store.selectMany(children) : undefined, { shortcut: 'Enter', disabled: !children.length }),
    ],
    [
      action('copy', 'Copy', selection.length ? copySelection : undefined, { shortcut: 'Ctrl+C', disabled: !selection.length, ...(!selection.length ? { reason: reason.empty } : {}) }),
      action('copy-link', 'Copy link', first ? copyLink : undefined, { disabled: !first }),
      action('copy-as', 'Copy as…', undefined, { children: [
        action('copy-react', 'Copy as React code', code ? () => writeClipboard(code) : undefined, { shortcut: 'Alt+R', disabled: !code, ...(!code ? { reason: reason.componentCode } : {}) }),
        action('copy-tailwind', 'Copy as Tailwind', undefined, { shortcut: 'Alt+T', disabled: true, reason: reason.tailwind }),
      ] }),
    ],
    [
      action('paste', 'Paste', bufferValid ? () => paste(false) : undefined, { shortcut: 'Ctrl+V', disabled: !bufferValid, ...(!bufferValid ? { reason: reason.paste } : {}) }),
      action('paste-on-top', 'Paste on top', bufferValid ? () => paste(true) : undefined, { shortcut: 'Ctrl+Shift+V', disabled: !bufferValid, ...(!bufferValid ? { reason: reason.paste } : {}) }),
      action('paste-to-replace', clipboardCopy.pasteToReplace, bufferValid && selection.length ? replace : undefined, { disabled: !bufferValid || !selection.length, ...(!bufferValid ? { reason: reason.paste } : !selection.length ? { reason: reason.empty } : {}) }),
      action('duplicate', 'Duplicate', selection.length ? () => store.commands.duplicate() : undefined, { shortcut: 'Ctrl+D', disabled: !selection.length }),
    ],
    layoutContextMenuGroup(
      action('frame', 'Frame selection', frame ? () => store.commands.executeBatch(frame.commands, frame.selection) : undefined, { shortcut: 'Shift+F', disabled: !frame }),
      flex,
      action('ungroup', 'Ungroup', ungroup ? () => store.commands.executeBatch(ungroup.commands, ungroup.selection) : undefined, { shortcut: 'Ctrl+Shift+G', disabled: !ungroup }),
    ),
    [
      action('front', 'Bring to front', () => order('front'), { shortcut: ']' }),
      action('back', 'Send to back', () => order('back'), { shortcut: '[' }),
      action('forward', 'Move forward', () => order('forward'), { shortcut: 'Ctrl+]' }),
      action('backward', 'Move backward', () => order('backward'), { shortcut: 'Ctrl+[' }),
    ],
  ]
  return <ContextMenu position={position} label="Layer actions" groups={groups} onClose={closeMenu} />
}
