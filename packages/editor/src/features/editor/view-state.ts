import type { Camera } from './canvas-math'

/**
 * Per-file viewing preferences, separate from design data and from editor preferences: the active page, the design
 * preview theme, and one camera per page. Stored locally per browser profile; never part of the design file.
 */
export type FileViewState = {
  fileId: string
  activePageId: string
  previewThemeId: string
  pageViews: Record<string, { camera: Camera }>
}
export const viewStateKey = 'design-editor.view-state.v1'
type ViewStorage = Pick<Storage, 'getItem' | 'setItem'>
type Collection = { schemaVersion: 1; files: Record<string, FileViewState> }
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const storage = (): ViewStorage | null => { try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null } }

function readCollection(source: ViewStorage | null): Collection {
  try {
    const raw = source?.getItem(viewStateKey)
    if (!raw) return { schemaVersion: 1, files: {} }
    const parsed = JSON.parse(raw) as Partial<Collection>
    if (parsed?.schemaVersion !== 1 || typeof parsed.files !== 'object' || parsed.files === null) return { schemaVersion: 1, files: {} }
    const files: Record<string, FileViewState> = {}
    for (const [fileId, view] of Object.entries(parsed.files)) { const valid = validateView(fileId, view); if (valid) files[fileId] = valid }
    return { schemaVersion: 1, files }
  } catch { return { schemaVersion: 1, files: {} } }
}

function validateView(fileId: string, value: unknown): FileViewState | null {
  if (!validId(fileId) || typeof value !== 'object' || value === null) return null
  const view = value as Partial<FileViewState>
  if (view.fileId !== fileId || !validId(view.activePageId) || !validId(view.previewThemeId) || typeof view.pageViews !== 'object' || view.pageViews === null) return null
  const pageViews: FileViewState['pageViews'] = {}
  for (const [pageId, pageView] of Object.entries(view.pageViews)) {
    const camera = (pageView as { camera?: Partial<Camera> } | null)?.camera
    if (!validId(pageId) || !camera || !finite(camera.x) || !finite(camera.y) || !finite(camera.zoom) || camera.zoom <= 0) continue
    pageViews[pageId] = { camera: { x: camera.x, y: camera.y, zoom: camera.zoom } }
  }
  return { fileId, activePageId: view.activePageId, previewThemeId: view.previewThemeId, pageViews }
}

export function readFileView(fileId: string, source: ViewStorage | null = storage()): FileViewState | null {
  return readCollection(source).files[fileId] ?? null
}

/** Writes one file's view state; a read-only store keeps the preference for this session only. */
export function writeFileView(view: FileViewState, source: ViewStorage | null = storage()): void {
  const valid = validateView(view.fileId, view)
  if (!valid) return
  try {
    const collection = readCollection(source)
    collection.files[view.fileId] = valid
    source?.setItem(viewStateKey, JSON.stringify(collection))
  } catch (error) { console.warn('The file view preference could not be stored for the next session.', error) }
}
