import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { IconName } from '../../design-system/atoms'
import { displayName } from './canvas-scene'
import { canvasComponentNode } from './component-canvas-link'

const icons: Record<string, IconName> = { frame: 'frame', rectangle: 'rectangle', shape: 'shape', shader: 'shader', text: 'text', component: 'component' }

export type LayerPresentation = Readonly<{ name: string; kind: string; icon: IconName }>

/** One semantic label and glyph shared by the Layers panel and every layer picker. */
export function layerPresentation(file: FileDocument, nodeId: string): LayerPresentation | null {
  const node = file.nodes[nodeId]
  if (!node || node.type === 'root') return null
  const component = canvasComponentNode(file, nodeId)
  const kind = component ? 'component' : node.type
  return { name: component?.definition.name ?? displayName(file, nodeId), kind, icon: icons[kind] ?? 'component' }
}
