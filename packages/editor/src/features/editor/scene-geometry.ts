import { createStore } from 'zustand/vanilla'
import type { Rect } from './canvas-math'
import type { LayoutStatus, PreviewBoxMeasure, PreviewGridMeasure, PreviewLayoutReport, PreviewMatrix, PreviewOffsetMeasure, PreviewThemeStatus } from '@canvas/preview-runtime/protocol'

/**
 * Measured world rectangles for mounted component nodes, plus what the runtime learned about each root: its mounted
 * parent, whether it is a direct DOM child of that parent, its own transform, resolved Grid tracks, and whether the
 * authored layout applied. Primitive nodes derive geometry from the document instead.
 */
export type MeasuredNode = { componentId: string; rect: Rect; box?: PreviewBoxMeasure; offset?: PreviewOffsetMeasure; offsetParentInstanceId?: string | null; parentInstanceId?: string | null; directChild?: boolean; transform?: PreviewMatrix; layout?: PreviewLayoutReport; grid?: PreviewGridMeasure; theme?: PreviewThemeStatus }
export type SceneGeometry = { nodes: Record<string, MeasuredNode>; revision: number; layoutGeneration: number | null; /** Nodes whose authored layout could not be applied and that have no measurable root. */ unsupported: Record<string, LayoutStatus>; /** Theme statuses of nodes without a measurable root, and portal roots that appeared without an owner. */ themeUnsupported: Record<string, PreviewThemeStatus>; unownedPortals: number }
const empty: SceneGeometry = { nodes: {}, revision: 0, layoutGeneration: null, unsupported: {}, themeUnsupported: {}, unownedPortals: 0 }
const backing = createStore<SceneGeometry>(() => empty)
export const sceneGeometry = {
  getSnapshot: backing.getState,
  subscribe: (listener: () => void) => backing.subscribe(listener),
  update: (nodes: Record<string, MeasuredNode>, layoutGeneration: number | null = null, unsupported: Record<string, LayoutStatus> = {}, theme: { themeUnsupported: Record<string, PreviewThemeStatus>; unownedPortals: number } = { themeUnsupported: {}, unownedPortals: 0 }) => backing.setState(state => ({ nodes, revision: state.revision + 1, layoutGeneration, unsupported, ...theme }), true),
  clear: () => backing.setState(state => (Object.keys(state.nodes).length || state.layoutGeneration !== null || Object.keys(state.unsupported).length || Object.keys(state.themeUnsupported).length || state.unownedPortals ? { nodes: {}, revision: state.revision + 1, layoutGeneration: null, unsupported: {}, themeUnsupported: {}, unownedPortals: 0 } : state), true),
}
