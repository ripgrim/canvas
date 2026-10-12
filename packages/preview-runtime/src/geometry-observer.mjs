import { isGeometryId, isPreviewBounds, isPreviewBoxMeasure, isPreviewGridMeasure, isPreviewLayoutReport, isPreviewMatrix, isPreviewOffsetMeasure, isPreviewTextMeasure, isPreviewThemeStatus } from './geometry.js'

const parseMatrix = text => {
  if (!text || text === 'none') return undefined
  const match = /^matrix\(([^)]+)\)$/.exec(text)
  if (!match) return undefined
  const parts = match[1].split(',').map(part => Number(part.trim()))
  return isPreviewMatrix(parts) ? parts : undefined
}
const identity = [1, 0, 0, 1, 0, 0]
const translation = (x, y) => [1, 0, 0, 1, x, y]
const multiply = (left, right) => {
  const [a1, b1, c1, d1, e1, f1] = left, [a2, b2, c2, d2, e2, f2] = right
  return [a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1]
}
const aboutOrigin = (matrix, origin) => multiply(translation(origin.x, origin.y), multiply(matrix, translation(-origin.x, -origin.y)))
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
const cssPixels = text => {
  const source = String(text ?? '').trim()
  return /^(?:\d+(?:\.\d+)?|\.\d+)px$/.test(source) ? Number.parseFloat(source) : undefined
}
const measureText = style => {
  const lineHeight = String(style.lineHeight ?? '').trim()
  let resolvedLineHeight
  if (lineHeight === 'normal') {
    const fontSize = cssPixels(style.fontSize)
    if (fontSize !== undefined) resolvedLineHeight = fontSize * 1.2
  } else resolvedLineHeight = cssPixels(lineHeight)
  const text = { resolvedLineHeight }
  return isPreviewTextMeasure(text) ? text : undefined
}

/**
 * Measures the mounted DOM roots of component nodes in iframe viewport CSS pixels.
 * `nodeIds` limits the result; `null` reports every mounted node so the editor can hit test the whole scene.
 * `extras.report` (node id to layout status) and `extras.layoutGeneration` come from the layout layer.
 */
export function collectPreviewGeometry(container, editorDocument, nodeIds, componentId, extras = {}) {
  const view = container.ownerDocument?.defaultView ?? null
  const copyRect = element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
  const layoutGeneration = Number.isSafeInteger(extras.layoutGeneration) && extras.layoutGeneration >= 0 ? extras.layoutGeneration : 0
  if (!editorDocument) {
    const bounds = copyRect(container)
    return { items: [], root: isGeometryId(componentId) && isPreviewBounds(bounds) ? { componentId, bounds } : null, documentRevision: 0, layoutGeneration }
  }
  const items = []
  const componentCandidates = [...container.querySelectorAll('[data-preview-instance]')]
  const canvasCandidates = [...container.querySelectorAll('[data-preview-canvas]')]
  const componentRootOf = id => {
    const node = editorDocument.nodes[id]
    if (!node) return null
    const matches = componentCandidates.filter(element => element.getAttribute('data-preview-instance') === id && element.getAttribute('data-preview-component') === node.componentId)
    return matches.length === 1 ? matches[0] : null
  }
  const canvasNodes = new Map((editorDocument.canvas?.elements ?? []).map(node => [node.id, node]))
  const canvasRootOf = id => {
    const node = canvasNodes.get(id)
    if (!node) return null
    const matches = canvasCandidates.filter(element => element.getAttribute('data-preview-canvas') === id && element.getAttribute('data-preview-kind') === node.kind)
    return matches.length === 1 ? matches[0] : null
  }
  const componentParents = new Map()
  for (const node of Object.values(editorDocument.nodes)) for (const ids of Object.values(node.children ?? {})) for (const childId of ids) componentParents.set(childId, node.id)
  const parentNodeIdOf = id => Object.hasOwn(editorDocument.nodes, id) ? componentParents.get(id) ?? null : canvasNodes.get(id)?.parentId ?? null
  const rootOf = id => componentRootOf(id) ?? canvasRootOf(id)
  const componentHost = container.querySelector?.('[data-preview-host]') ?? null
  const wanted = nodeIds === null || nodeIds === undefined ? [...Object.keys(editorDocument.nodes), ...canvasNodes.keys()] : [...new Set(nodeIds)]
  for (const id of wanted.slice(0, 500)) {
    const componentNode = editorDocument.nodes[id]
    const canvasNode = canvasNodes.get(id)
    if (!isGeometryId(id) || componentNode && !isGeometryId(componentNode.componentId) || canvasNode && !['frame', 'rectangle', 'shape', 'shader', 'text'].includes(canvasNode.kind)) continue
    const element = componentNode ? componentRootOf(id) : canvasNode ? canvasRootOf(id) : null
    if (!element) continue
    const worldAabb = copyRect(element)
    if (!isPreviewBounds(worldAabb)) continue
    const bounds = { ...worldAabb }
    const item = componentNode
      ? { instanceId: id, source: 'component', componentId: componentNode.componentId, bounds, worldAabb }
      : { instanceId: id, source: 'canvas', canvasKind: canvasNode.kind, bounds, worldAabb }
    const intendedParentId = parentNodeIdOf(id)
    const intendedParent = intendedParentId === null ? componentNode ? componentHost : container : rootOf(intendedParentId)
    item.directChild = intendedParent !== null && element.parentElement === intendedParent
    if (componentNode) {
      // Topology belongs to imported component roots. Native canvas nodes preserve their authored hierarchy.
      const ancestor = element.parentElement?.closest('[data-preview-instance]') ?? null
      const ancestorId = ancestor?.getAttribute('data-preview-instance') ?? null
      const parentRoot = ancestorId !== null && isGeometryId(ancestorId) ? componentRootOf(ancestorId) : null
      item.parentInstanceId = parentRoot === ancestor && ancestorId !== null ? ancestorId : null
    }
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
        if (intendedParent !== null && offsetParent === intendedParent) {
          item.offsetParentNodeId = intendedParentId
          if (componentNode) item.offsetParentInstanceId = intendedParentId !== null && componentRootOf(intendedParentId) === intendedParent ? intendedParentId : null
          if (intendedParentId === null) {
            let toRoot
            if (offsetParent === container) toRoot = identity
            else if (offsetParent.parentElement === container && offsetParent.offsetParent === container) {
              const parentStyle = view.getComputedStyle(offsetParent)
              const parentTransform = parentStyle.transform === 'none' || !parentStyle.transform ? identity : parseMatrix(parentStyle.transform)
              const parentOrigin = String(parentStyle.transformOrigin).split(' ').map(part => Number.parseFloat(part))
              const x = Number(offsetParent.offsetLeft), y = Number(offsetParent.offsetTop)
              if (parentTransform && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(parentOrigin[0]) && Number.isFinite(parentOrigin[1])) {
                const borderEdge = translation(pixels(parentStyle.borderLeftWidth), pixels(parentStyle.borderTopWidth))
                toRoot = multiply(multiply(translation(x, y), aboutOrigin(parentTransform, { x: parentOrigin[0], y: parentOrigin[1] })), borderEdge)
              }
            }
            if (isPreviewMatrix(toRoot)) item.offsetParentToRoot = toRoot
          }
        }
      }
      const transform = parseMatrix(style.transform)
      if (transform) item.transform = transform
      if (canvasNode && transform && item.offset) {
        // Canvas selection keeps the authored rotation. Report the untransformed border box around the same visual
        // center, otherwise getBoundingClientRect's rotated AABB would be rotated a second time by editor chrome.
        const zoom = Number.isFinite(extras.camera?.zoom) && extras.camera.zoom > 0 ? extras.camera.zoom : 1
        const exact = { x: bounds.x + bounds.width / 2 - item.offset.width * zoom / 2, y: bounds.y + bounds.height / 2 - item.offset.height * zoom / 2, width: item.offset.width * zoom, height: item.offset.height * zoom }
        if (isPreviewBounds(exact)) item.bounds = exact
      }
      const grid = measureGrid(view, element)
      if (grid) item.grid = grid
      if (canvasNode?.kind === 'text') {
        const text = measureText(style)
        if (text) item.text = text
      }
    }
    if (componentNode) {
      const report = extras.report?.get(id)
      if (report && isPreviewLayoutReport(report)) item.layout = { status: report.status, conflicts: [...report.conflicts] }
      const themeStatus = extras.theme?.nodes?.get(id)
      if (isPreviewThemeStatus(themeStatus)) item.theme = themeStatus
    }
    items.push(item)
  }
  const result = { items, root: null, documentRevision: editorDocument.revision, layoutGeneration }
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
  const measure = (force = false) => {
    frame = null
    if (!active || suspended && !force) return
    const elements = [container, ...container.querySelectorAll('[data-preview-instance], [data-preview-canvas]')]
    for (const element of observed) if (!elements.includes(element)) { resize.unobserve(element); observed.delete(element) }
    for (const element of elements) if (!observed.has(element)) { resize.observe(element); observed.add(element) }
    const camera = getCamera ? getCamera() : null
    const geometry = collectPreviewGeometry(container, editorDocument, selectedIds, componentId, { ...(getExtras ? getExtras() : {}), ...(camera ? { camera } : {}) })
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
    /** Synchronous pre-paint barrier used after temporarily removing a retained interaction overlay. */
    measureNow: () => measure(true),
    refresh, stop, dispose: stop,
  }
}
