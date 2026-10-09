import { isGeometryId, isPreviewBounds, isPreviewBoxMeasure, isPreviewGridMeasure, isPreviewLayoutReport, isPreviewMatrix, isPreviewOffsetMeasure, isPreviewThemeStatus } from './geometry.js'

const parseMatrix = text => {
  if (!text || text === 'none') return undefined
  const match = /^matrix\(([^)]+)\)$/.exec(text)
  if (!match) return undefined
  const parts = match[1].split(',').map(part => Number(part.trim()))
  return isPreviewMatrix(parts) ? parts : undefined
}
const pixels = text => { const value = Number.parseFloat(text); return Number.isFinite(value) && value >= 0 ? value : 0 }
const tracks = text => (text && text !== 'none' ? text.split(' ').map(pixels) : [])
// Computed content alignment uses flex and legacy keywords; `normal` behaves as stretch for grid content.
const distribution = text => ({ normal: 'stretch', stretch: 'stretch', start: 'start', 'flex-start': 'start', left: 'start', end: 'end', 'flex-end': 'end', right: 'end', center: 'center', 'space-between': 'space-between', 'space-around': 'space-around', 'space-evenly': 'space-evenly' })[String(text).trim().split(' ').pop()]
/** Resolved Grid tracks, gaps and padding read from computed style; only containers whose used display is grid report them. */
const measureGrid = (view, element) => {
  const style = view.getComputedStyle(element)
  if (style.display !== 'grid' && style.display !== 'inline-grid') return undefined
  const grid = { columns: tracks(style.gridTemplateColumns), rows: tracks(style.gridTemplateRows), columnGap: pixels(style.columnGap), rowGap: pixels(style.rowGap), padding: { top: pixels(style.paddingTop), right: pixels(style.paddingRight), bottom: pixels(style.paddingBottom), left: pixels(style.paddingLeft) } }
  const justifyContent = distribution(style.justifyContent), alignContent = distribution(style.alignContent)
  if (justifyContent) grid.justifyContent = justifyContent
  if (alignContent) grid.alignContent = alignContent
  return isPreviewGridMeasure(grid) ? grid : undefined
}

/**
 * Measures the mounted DOM roots of component nodes in iframe viewport CSS pixels.
 * `nodeIds` limits the result; `null` reports every mounted node so the editor can hit test the whole scene.
 * `extras.report` (node id to layout status) and `extras.layoutGeneration` come from the layout layer.
 */
export function collectPreviewGeometry(container, editorDocument, nodeIds, componentId, extras = {}) {
  const view = container.ownerDocument?.defaultView ?? null
  const copyRect = element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
  if (!editorDocument) {
    const bounds = copyRect(container)
    return { items: [], root: isGeometryId(componentId) && isPreviewBounds(bounds) ? { componentId, bounds } : null }
  }
  const items = []
  const candidates = [...container.querySelectorAll('[data-preview-instance]')]
  const rootOf = id => {
    const node = editorDocument.nodes[id]
    if (!node) return null
    const matches = candidates.filter(element => element.getAttribute('data-preview-instance') === id && element.getAttribute('data-preview-component') === node.componentId)
    return matches.length === 1 ? matches[0] : null
  }
  const wanted = nodeIds === null || nodeIds === undefined ? Object.keys(editorDocument.nodes) : [...new Set(nodeIds)]
  for (const id of wanted.slice(0, 500)) {
    const node = editorDocument.nodes[id]
    if (!node || !isGeometryId(id) || !isGeometryId(node.componentId)) continue
    const element = rootOf(id)
    if (!element) continue
    const bounds = copyRect(element)
    if (!isPreviewBounds(bounds)) continue
    const item = { instanceId: id, componentId: node.componentId, bounds }
    // Topology: the closest mounted component ancestor and whether this root is its direct DOM child.
    const ancestor = element.parentElement?.closest('[data-preview-instance]') ?? null
    const ancestorId = ancestor?.getAttribute('data-preview-instance') ?? null
    const parentRoot = ancestorId !== null && isGeometryId(ancestorId) ? rootOf(ancestorId) : null
    item.parentInstanceId = parentRoot === ancestor && ancestorId !== null ? ancestorId : null
    item.directChild = item.parentInstanceId !== null && element.parentElement === ancestor
    if (view) {
      const style = view.getComputedStyle(element)
      const box = { padding: { top: pixels(style.paddingTop), right: pixels(style.paddingRight), bottom: pixels(style.paddingBottom), left: pixels(style.paddingLeft) }, border: { top: pixels(style.borderTopWidth), right: pixels(style.borderRightWidth), bottom: pixels(style.borderBottomWidth), left: pixels(style.borderLeftWidth) } }
      if (isPreviewBoxMeasure(box)) item.box = box
      // The untransformed box and origin let the editor rebuild exact world matrices for reparenting under rotation or scale.
      const originParts = String(style.transformOrigin).split(' ').map(part => Number.parseFloat(part))
      // offset* values are integers; used values from computed style keep fractions (border box when box-sizing says so).
      const extra = (axis) => axis === 'x' ? box.padding.left + box.padding.right + box.border.left + box.border.right : box.padding.top + box.padding.bottom + box.border.top + box.border.bottom
      const usedSize = (property, axis, fallback) => { const used = Number.parseFloat(style[property]); return Number.isFinite(used) ? (style.boxSizing === 'border-box' ? used : used + extra(axis)) : fallback }
      const usedInset = (property, fallback) => { const used = Number.parseFloat(style[property]); return style.position === 'absolute' && Number.isFinite(used) ? used : fallback }
      const offset = { x: usedInset('left', element.offsetLeft), y: usedInset('top', element.offsetTop), width: usedSize('width', 'x', element.offsetWidth), height: usedSize('height', 'y', element.offsetHeight), origin: { x: Number.isFinite(originParts[0]) ? originParts[0] : 0, y: Number.isFinite(originParts[1]) ? originParts[1] : 0 } }
      if (isPreviewOffsetMeasure(offset)) {
        item.offset = offset
        const offsetParent = element.offsetParent
        const offsetParentId = offsetParent?.getAttribute?.('data-preview-instance') ?? null
        item.offsetParentInstanceId = offsetParentId !== null && isGeometryId(offsetParentId) && rootOf(offsetParentId) === offsetParent ? offsetParentId : null
      }
      const transform = parseMatrix(style.transform)
      if (transform) item.transform = transform
      const grid = measureGrid(view, element)
      if (grid) item.grid = grid
    }
    const report = extras.report?.get(id)
    if (report && isPreviewLayoutReport(report)) item.layout = { status: report.status, conflicts: [...report.conflicts] }
    const themeStatus = extras.theme?.nodes?.get(id)
    if (isPreviewThemeStatus(themeStatus)) item.theme = themeStatus
    items.push(item)
  }
  const result = { items, root: null }
  if (Number.isSafeInteger(extras.layoutGeneration) && extras.layoutGeneration >= 0) result.layoutGeneration = extras.layoutGeneration
  // Nodes the layout layer could not resolve to one root have no item to carry their status, so they travel separately.
  const measured = new Set(items.map(item => item.instanceId))
  const unsupported = [...(extras.report ?? new Map())].filter(([id, report]) => !measured.has(id) && isGeometryId(id) && report.status !== 'applied').map(([id, report]) => ({ instanceId: id, status: report.status })).slice(0, 500)
  if (unsupported.length) result.unsupported = unsupported
  if (extras.theme) {
    const nodes = [...extras.theme.nodes].filter(([id, status]) => !measured.has(id) && isGeometryId(id) && status !== 'applied').map(([id, status]) => ({ instanceId: id, status })).slice(0, 500)
    const unownedPortals = Number.isSafeInteger(extras.theme.unownedPortals) && extras.theme.unownedPortals >= 0 ? extras.theme.unownedPortals : 0
    if (nodes.length || unownedPortals) result.theme = { nodes, unownedPortals }
  }
  return result
}
export function createGeometryObserver(container, publish, getCamera = null, getExtras = null) {
  const view = container.ownerDocument.defaultView
  let active = false
  let suspended = false
  let frame = null
  let editorDocument = null
  let selectedIds = null
  let componentId = null
  const observed = new Set()
  const measure = () => {
    frame = null
    if (!active || suspended) return
    const elements = [container, ...container.querySelectorAll('[data-preview-instance]')]
    for (const element of observed) if (!elements.includes(element)) { resize.unobserve(element); observed.delete(element) }
    for (const element of elements) if (!observed.has(element)) { resize.observe(element); observed.add(element) }
    const geometry = collectPreviewGeometry(container, editorDocument, selectedIds, componentId, getExtras ? getExtras() : {})
    const camera = getCamera ? getCamera() : null
    publish(camera ? { ...geometry, camera } : geometry)
  }
  const refresh = () => { if (active && !suspended && frame === null) frame = view.requestAnimationFrame(measure) }
  const resize = new view.ResizeObserver(refresh)
  const mutation = new view.MutationObserver(refresh)
  const stop = () => { active = false; suspended = false; if (frame !== null) view.cancelAnimationFrame(frame); frame = null; resize.disconnect(); mutation.disconnect(); observed.clear(); view.removeEventListener('scroll', refresh, true); view.removeEventListener('resize', refresh) }
  return {
    start: () => { if (active) return; active = true; mutation.observe(container, { subtree: true, childList: true, attributes: true, characterData: true }); view.addEventListener('scroll', refresh, true); view.addEventListener('resize', refresh); refresh() },
    update: (document, ids, rootComponentId) => { editorDocument = document; selectedIds = ids === null || ids === undefined ? null : [...ids]; componentId = rootComponentId; refresh() },
    /** Holds measurement while a batch of inline writes lands; resume measures once afterwards. */
    suspend: () => { suspended = true; if (frame !== null) { view.cancelAnimationFrame(frame); frame = null } },
    resume: () => { suspended = false; refresh() },
    refresh, stop, dispose: stop,
  }
}
