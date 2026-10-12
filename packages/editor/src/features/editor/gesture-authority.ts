import { childrenOf, pageRoot } from '@canvas/repo-engine/file-document'
import type { Matrix } from '@canvas/repo-engine/layout-matrix'
import type { DocumentState } from './document-store'
import { buildScene } from './canvas-scene'
import type { Camera, Point, Rect, Size } from './canvas-math'
import type { GestureCommandSnapshot } from './gesture-command-planner'
import type { SceneGeometry } from './scene-geometry'

export type GestureAuthorityDocumentState = Pick<DocumentState, 'file' | 'pageId' | 'atoms' | 'layoutGeneration' | 'viewport' | 'viewportSize' | 'selection'>

export type GestureAuthoritySnapshot = GestureCommandSnapshot & Readonly<{
  pageId: string
  camera: Readonly<Camera>
  size: Readonly<Size>
  selection: readonly string[]
}>

export type ResizeGeometryAuthority = Readonly<{
  coordinateSpace: 'parent-padding'
  fileId: string
  pageId: string
  pageRootId: string
  nodeId: string
  parentId: string
  fence: GestureCommandSnapshot['start']
  startRect: Readonly<Rect>
  groupToWorld: Matrix
  worldToGroup: Matrix
  rotationDegrees: number
  transformOrigin: Readonly<Point>
}>

const generation = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value
  const object = value as object
  if (seen.has(object)) return value
  seen.add(object)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
  return Object.freeze(value)
}

/** Captures one pointer-down authority without mixing document and measurement reads from different generations. */
export function captureGestureAuthority(
  getDocumentState: () => GestureAuthorityDocumentState,
  getGeometry: () => SceneGeometry,
): GestureAuthoritySnapshot | null {
  const state = getDocumentState()
  const geometry = getGeometry()
  const file = state.file
  const pageId = state.pageId
  if (!file || !pageId || !generation(file.revision) || !generation(state.layoutGeneration)) return null
  if (!generation(geometry.revision) || !generation(geometry.documentRevision) || geometry.documentRevision !== file.revision) return null
  if (!generation(geometry.layoutGeneration) || geometry.layoutGeneration !== state.layoutGeneration) return null
  const rootId = pageRoot(file, pageId)
  if (!rootId || file.nodes[rootId]?.type !== 'root') return null
  for (const measurement of Object.values(geometry.nodes)) {
    if (measurement.documentRevision !== undefined && (!generation(measurement.documentRevision) || measurement.documentRevision !== file.revision)) return null
    if (measurement.layoutGeneration !== undefined && (!generation(measurement.layoutGeneration) || measurement.layoutGeneration !== state.layoutGeneration)) return null
  }
  let scene
  let atoms
  try {
    scene = buildScene(file, pageId, geometry.nodes, state.layoutGeneration)
    atoms = deepFreeze(structuredClone(state.atoms))
  } catch {
    return null
  }
  if (childrenOf(file, rootId).length > 0 && scene.nodes.length === 0) return null
  const start = Object.freeze({
    fileId: file.fileId,
    fileRevision: file.revision,
    measurementRevision: geometry.revision,
    documentRevision: geometry.documentRevision,
    layoutGeneration: state.layoutGeneration,
  })
  return Object.freeze({
    file,
    atoms,
    scene,
    geometry,
    layoutGeneration: state.layoutGeneration,
    start,
    pageId,
    camera: Object.freeze({ ...state.viewport }),
    size: Object.freeze({ ...state.viewportSize }),
    selection: Object.freeze([...state.selection]),
  })
}
