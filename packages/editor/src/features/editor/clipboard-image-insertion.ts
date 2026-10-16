import { applyFileCommand, nodeChildDisplay, nodeWorldTransform } from '@canvas/repo-engine/file-document'
import type { FileCommand, FileDocument, FileNode, ImageAssetReference } from '@canvas/repo-engine/file-document'
import { invertTransform, transformPoint } from '@canvas/repo-engine/transform-matrix'
import type { Atom } from './types'
import { nearestCompatiblePasteParent } from './clipboard-placement'

export type ClipboardImagePlacement = Readonly<{
  center: Readonly<{ x: number; y: number }>
  visibleSize: Readonly<{ width: number; height: number }>
  selection: readonly string[]
  containSelectionAtCenter?: boolean
}>

export type ClipboardImageInsertionPlan = Readonly<{
  command: FileCommand
  selection: readonly string[]
}>

const gap = 20
const maxNaturalSide = 400

const imageSize = (asset: ImageAssetReference) => {
  const scale = Math.min(1, maxNaturalSide / asset.width, maxNaturalSide / asset.height)
  return { width: Math.max(1, asset.width * scale), height: Math.max(1, asset.height * scale) }
}

export function planClipboardImageInsertion(
  file: FileDocument,
  pageId: string,
  assets: readonly ImageAssetReference[],
  placement: ClipboardImagePlacement,
  makeId: () => string,
  atoms: readonly Atom[] = [],
): ClipboardImageInsertionPlan {
  if (!assets.length) throw new Error('Choose at least one verified image')
  const rectangleProbe: FileNode = { id: 'clipboard-probe', type: 'rectangle', name: 'Image', styles: { relativeTransform: [1, 0, 0, 1, 0, 0], width: 1, height: 1 } }
  const target = nearestCompatiblePasteParent(file, pageId, placement.selection, [rectangleProbe], atoms, placement.containSelectionAtCenter ? placement.center : undefined)
  const targetId = target.id
  const flow = nodeChildDisplay(target) === 'flex'
  const base = assets.map(imageSize)
  const totalWidth = base.reduce((sum, size) => sum + size.width, 0) + gap * Math.max(0, base.length - 1)
  const maxHeight = Math.max(...base.map(size => size.height))
  const availableWidth = Math.max(1, placement.visibleSize.width * 0.8)
  const availableHeight = Math.max(1, placement.visibleSize.height * 0.8)
  const scale = flow ? 1 : Math.min(1, availableWidth / totalWidth, availableHeight / maxHeight)
  const sizes = base.map(size => ({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }))
  const scaledGap = Math.max(1, Math.round(gap * scale))
  const rowWidth = sizes.reduce((sum, size) => sum + size.width, 0) + scaledGap * Math.max(0, sizes.length - 1)
  const parentInverse = target.type === 'root' ? null : invertTransform(nodeWorldTransform(file, target.id))
  const localCenter = parentInverse ? transformPoint(parentInverse, placement.center) : placement.center
  let x = localCenter.x - rowWidth / 2
  const commands: FileCommand[] = assets.map(asset => ({ type: 'asset.attach', asset }))
  const selection: string[] = []
  for (let index = 0; index < assets.length; index++) {
    const asset = assets[index]!
    const size = sizes[index]!
    const id = makeId()
    const fillId = makeId()
    const node: FileNode = {
      id,
      type: 'rectangle',
      name: asset.name.replace(/\.[^.]+$/, '') || 'Image',
      styles: { relativeTransform: [1, 0, 0, 1, flow ? 0 : Math.round(x), flow ? 0 : Math.round(localCenter.y - size.height / 2)], width: size.width, height: size.height },
      appearance: { fills: [{ id: fillId, type: 'image', assetId: asset.id, fit: 'cover' }] },
      layout: { item: { position: { mode: flow ? 'flow' : 'freeform' } } },
    }
    commands.push({ type: 'node.insert', node, placement: { parentId: targetId } })
    selection.push(id)
    x += size.width + scaledGap
  }
  const command: FileCommand = { type: 'batch', commands }
  applyFileCommand(file, command, [...atoms], { allowUnavailableBindings: true })
  return Object.freeze({ command, selection: Object.freeze(selection) })
}
