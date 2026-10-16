import { createStore } from 'zustand/vanilla'
import type { StoreApi } from 'zustand/vanilla'
import type { PrimitiveKind } from '@canvas/repo-engine/file-document'
import type { Rect } from './canvas-math'
import type { LayoutStatus, PreviewBoxMeasure, PreviewGridMeasure, PreviewLayoutReport, PreviewMatrix, PreviewOffsetMeasure, PreviewTextMeasure, PreviewThemeStatus } from '@canvas/preview-runtime/protocol'

/**
 * Measured world rectangles for mounted component roots and native canvas nodes. Component measurements also carry
 * topology and layout reports. Native measurements let intrinsic text sizing use the DOM's actual used dimensions.
 */
export type MeasuredNode = { componentId?: string; canvasKind?: PrimitiveKind; documentRevision?: number; layoutGeneration?: number; rect: Rect; worldAabb?: Rect; box?: PreviewBoxMeasure; offset?: PreviewOffsetMeasure; offsetParentNodeId?: string | null; offsetParentToRoot?: PreviewMatrix; offsetParentInstanceId?: string | null; parentInstanceId?: string | null; directChild?: boolean; transform?: PreviewMatrix; layout?: PreviewLayoutReport; grid?: PreviewGridMeasure; text?: PreviewTextMeasure; theme?: PreviewThemeStatus }
export type SceneGeometry = { nodes: Record<string, MeasuredNode>; revision: number; documentRevision: number | null; layoutGeneration: number | null; /** A temporary interruption may retain presentation only. Writes and gestures still see no nodes. */ gap?: 'temporary' | 'retired'; /** Nodes whose authored layout could not be applied and that have no measurable root. */ unsupported: Record<string, LayoutStatus>; /** Theme statuses of nodes without a measurable root, and portal roots that appeared without an owner. */ themeUnsupported: Record<string, PreviewThemeStatus>; unownedPortals: number }
const empty: SceneGeometry = { nodes: {}, revision: 0, documentRevision: null, layoutGeneration: null, gap: 'retired', unsupported: {}, themeUnsupported: {}, unownedPortals: 0 }
// Keep renderer authority stable across HMR.
const hotData = import.meta.hot?.data
const backing = (hotData?.sceneGeometry as StoreApi<SceneGeometry> | undefined) ?? createStore<SceneGeometry>(() => empty)
if (hotData) hotData.sceneGeometry = backing
export const sceneGeometry = {
  getSnapshot: backing.getState,
  subscribe: (listener: () => void) => backing.subscribe(listener),
  update: (nodes: Record<string, MeasuredNode>, projection: { documentRevision: number; layoutGeneration: number; measurementRevision: number } | null = null, unsupported: Record<string, LayoutStatus> = {}, theme: { themeUnsupported: Record<string, PreviewThemeStatus>; unownedPortals: number } = { themeUnsupported: {}, unownedPortals: 0 }) => backing.setState(state => ({ nodes, revision: projection?.measurementRevision ?? state.revision + 1, documentRevision: projection?.documentRevision ?? null, layoutGeneration: projection?.layoutGeneration ?? null, unsupported, ...theme }), true),
  clear: (gap: 'temporary' | 'retired' = 'retired') => backing.setState(state => (Object.keys(state.nodes).length || state.revision !== 0 || state.documentRevision !== null || state.layoutGeneration !== null || state.gap !== gap || Object.keys(state.unsupported).length || Object.keys(state.themeUnsupported).length || state.unownedPortals ? { ...empty, gap } : state), true),
}
