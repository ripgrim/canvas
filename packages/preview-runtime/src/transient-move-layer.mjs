import { fillGeometryStyle } from './scene-styles.mjs'

const selectorFor = nodeId => `[data-preview-instance="${nodeId}"], [data-preview-canvas="${nodeId}"]`
const cssName = name => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`).replace(/^webkit-/, '-webkit-')
const stripDomIds = element => {
  element.removeAttribute('id')
  for (const child of element.querySelectorAll('[id]')) child.removeAttribute('id')
}

/**
 * Moves mounted design roots and temporarily sizes primitive canvas nodes during a pointer gesture. The layer owns no
 * DOM and restores the exact inline declarations before layout, render, commit, or disposal can observe them.
 */
export function createTransientMoveLayer(ownerDocument, container) {
  const applied = new Map()
  let canvasById = new Map()
  let items = []
  let editorDocument = null
  let frame = 0

  const restoreProperty = (state, property) => {
    const original = state.originals.get(property)
    if (!original) return
    if (original.value) state.element.style.setProperty(property, original.value, original.priority)
    else state.element.style.removeProperty(property)
  }
  const restore = nodeId => {
    const state = applied.get(nodeId)
    if (!state) return
    if (state.clone) {
      state.element.remove()
      applied.delete(nodeId)
      return
    }
    for (const property of state.originals.keys()) restoreProperty(state, property)
    applied.delete(nodeId)
  }
  const clear = () => {
    for (const nodeId of [...applied.keys()]) restore(nodeId)
  }
  const stateFor = item => {
    const existing = applied.get(item.nodeId)
    if (existing && existing.clone === Boolean(item.duplicate)) return existing
    if (existing) restore(item.nodeId)
    const source = container.querySelector(selectorFor(item.nodeId))
    if (!(source instanceof ownerDocument.defaultView.HTMLElement)) return null
    const element = item.duplicate ? source.cloneNode(true) : source
    if (!(element instanceof ownerDocument.defaultView.HTMLElement)) return null
    if (item.duplicate) {
      stripDomIds(element)
      element.setAttribute('data-preview-transient-clone', '')
      element.setAttribute('aria-hidden', 'true')
      element.inert = true
      element.style.setProperty('pointer-events', 'none', 'important')
      element.style.setProperty('z-index', '1000000')
      source.parentElement?.insertBefore(element, source.nextSibling)
    }
    const computed = ownerDocument.defaultView.getComputedStyle(element).translate
    const pixels = /^(-?\d+(?:\.\d+)?)px(?: (-?\d+(?:\.\d+)?)px)?$/.exec(computed)
    const state = {
      element,
      originals: new Map(),
      activeProperties: new Set(),
      nextProperties: new Set(),
      seenFrame: frame,
      baseX: pixels ? Number(pixels[1]) : 0,
      baseY: pixels?.[2] ? Number(pixels[2]) : 0,
      clone: Boolean(item.duplicate),
    }
    applied.set(item.nodeId, state)
    return state
  }
  const capture = (state, property) => {
    if (state.originals.has(property)) return
    state.originals.set(property, { value: state.element.style.getPropertyValue(property), priority: state.element.style.getPropertyPriority(property) })
  }
  const apply = () => {
    frame += 1
    for (const item of items) {
      const state = stateFor(item)
      if (!state) continue
      state.seenFrame = frame
      const canvas = canvasById.get(item.nodeId)
      const geometry = item.appearance?.fills && canvas ? fillGeometryStyle(item.appearance.fills, editorDocument.assets) : null
      const width = canvas ? item.width : undefined
      const height = canvas ? item.height : undefined
      const nextProperties = state.nextProperties
      nextProperties.clear()
      nextProperties.add('translate')
      nextProperties.add('will-change')
      if (width !== undefined || height !== undefined) nextProperties.add('box-sizing')
      if (width !== undefined) nextProperties.add('width')
      if (height !== undefined) nextProperties.add('height')
      if (item.rotationDelta !== undefined) nextProperties.add('rotate')
      if (geometry) for (const property in geometry) nextProperties.add(cssName(property))
      for (const property of state.activeProperties) if (!nextProperties.has(property)) restoreProperty(state, property)
      for (const property of nextProperties) capture(state, property)
      state.activeProperties.clear()
      for (const property of nextProperties) state.activeProperties.add(property)
      state.element.style.setProperty('translate', `${item.dx + state.baseX}px ${item.dy + state.baseY}px`, 'important')
      state.element.style.setProperty('will-change', geometry ? 'translate, width, height, background-position, background-size' : 'translate', 'important')
      if (width !== undefined || height !== undefined) state.element.style.setProperty('box-sizing', 'border-box', 'important')
      if (width !== undefined) state.element.style.setProperty('width', `${width}px`, 'important')
      if (height !== undefined) state.element.style.setProperty('height', `${height}px`, 'important')
      if (item.rotationDelta !== undefined) state.element.style.setProperty('rotate', `${item.rotationDelta}deg`, 'important')
      if (geometry) for (const property in geometry) {
        const name = cssName(property)
        if (state.element.style.getPropertyValue(name) !== geometry[property] || state.element.style.getPropertyPriority(name) !== 'important') state.element.style.setProperty(name, geometry[property], 'important')
      }
    }
    for (const [nodeId, state] of applied) if (state.seenFrame !== frame) restore(nodeId)
  }

  return {
    update: next => { items = next; apply() },
    setDocument: document => {
      editorDocument = document
      canvasById = new Map((document?.canvas?.elements ?? []).map(element => [element.id, element]))
    },
    reapply: () => { clear(); apply() },
    clear,
    dispose: () => { clear(); items = []; editorDocument = null; canvasById = new Map() },
  }
}

/**
 * Coordinate-explicit v7 presentation layer. This is separate from the legacy transient move layer while the live
 * controller migrates. Each node has one declaration owner and every owned inline value is restored byte-for-byte.
 */
export function createTransientPresentationLayer(ownerDocument, container) {
  const applied = new Map()
  let editorDocument = null
  let presentations = []
  let frame = 0

  const restoreProperty = (state, property) => {
    const original = state.originals.get(property)
    if (!original) return
    if (original.value) state.element.style.setProperty(property, original.value, original.priority)
    else state.element.style.removeProperty(property)
  }
  const restore = nodeId => {
    const state = applied.get(nodeId)
    if (!state) return
    for (const property of state.originals.keys()) restoreProperty(state, property)
    applied.delete(nodeId)
  }
  const restoreAll = () => {
    for (const nodeId of [...applied.keys()]) restore(nodeId)
  }
  const readProperty = (element, property) => ({ value: element.style.getPropertyValue(property), priority: element.style.getPropertyPriority(property) })
  const sameProperty = (left, right) => left.value === right.value && left.priority === right.priority
  const captureDrift = state => {
    for (const property of state.activeProperties) {
      const current = readProperty(state.element, property)
      const written = state.written.get(property)
      if (written && sameProperty(current, written)) continue
      state.originals.set(property, current)
    }
  }
  const stateFor = item => {
    const existing = applied.get(item.nodeId)
    const element = container.querySelector(selectorFor(item.nodeId))
    if (existing && existing.element === element) { captureDrift(existing); return existing }
    if (existing) restore(item.nodeId)
    if (!(element instanceof ownerDocument.defaultView.HTMLElement)) return null
    const computed = ownerDocument.defaultView.getComputedStyle(element).translate
    const pixels = /^(-?\d+(?:\.\d+)?)px(?: (-?\d+(?:\.\d+)?)px)?$/.exec(computed)
    const state = {
      element,
      originals: new Map(),
      activeProperties: new Set(),
      written: new Map(),
      seenFrame: frame,
      baseX: pixels ? Number(pixels[1]) : 0,
      baseY: pixels?.[2] ? Number(pixels[2]) : 0,
    }
    applied.set(item.nodeId, state)
    return state
  }
  const capture = (state, property) => {
    if (state.originals.has(property)) return
    state.originals.set(property, { value: state.element.style.getPropertyValue(property), priority: state.element.style.getPropertyPriority(property) })
  }
  const declarationMap = (presentation, item, state) => {
    if (presentation.kind === 'move-world') return new Map([
      ['translate', `${item.dx + state.baseX}px ${item.dy + state.baseY}px`],
      ['will-change', 'translate'],
    ])
    const declarations = new Map([
      ['left', `${item.rect.x}px`],
      ['top', `${item.rect.y}px`],
      ['width', `${item.rect.width}px`],
      ['height', `${item.rect.height}px`],
      ['box-sizing', 'border-box'],
    ])
    const geometry = item.appearance?.fills ? fillGeometryStyle(item.appearance.fills, editorDocument?.assets) : null
    if (geometry) for (const property in geometry) declarations.set(cssName(property), geometry[property])
    return declarations
  }
  const apply = () => {
    frame += 1
    for (const presentation of presentations) for (const item of presentation.items) {
      const state = stateFor(item)
      if (!state) continue
      state.seenFrame = frame
      const declarations = declarationMap(presentation, item, state)
      for (const property of state.activeProperties) if (!declarations.has(property)) restoreProperty(state, property)
      state.activeProperties.clear()
      state.written.clear()
      for (const [property, value] of declarations) {
        capture(state, property)
        state.activeProperties.add(property)
        if (state.element.style.getPropertyValue(property) !== value || state.element.style.getPropertyPriority(property) !== 'important') state.element.style.setProperty(property, value, 'important')
        state.written.set(property, readProperty(state.element, property))
      }
    }
    for (const [nodeId, state] of applied) if (state.seenFrame !== frame) restore(nodeId)
  }

  const observer = typeof ownerDocument.defaultView.MutationObserver === 'function' ? new ownerDocument.defaultView.MutationObserver(apply) : null
  observer?.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'data-preview-instance', 'data-preview-canvas'] })

  return {
    update: next => { presentations = next; apply() },
    setDocument: document => { editorDocument = document },
    clear: () => { presentations = []; restoreAll() },
    dispose: () => { observer?.disconnect(); presentations = []; restoreAll(); editorDocument = null },
  }
}

const matrixText = matrix => `matrix(${matrix.join(', ')})`
const flowKey = presentation => `${presentation.identity.interactionId}:${presentation.identity.gestureGeneration}`

/**
 * Dedicated Paper flow-drag projection. Absolute nodes consume the editor-supplied offset-parent matrix literally;
 * flow nodes keep their authored root in place and paint an identity-free fill ghost. No computed style is used to
 * reconstruct either pose.
 */
export function createFlowDragLayer(ownerDocument, container) {
  const view = ownerDocument.defaultView
  const applied = new Map()
  const visuals = new Map()
  let editorDocument = null
  let presentations = []
  let applying = false

  const read = (element, name) => ({ value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name) })
  const same = (left, right) => left.value === right.value && left.priority === right.priority
  const restoreState = state => {
    captureDrift(state)
    for (const [name, original] of state.originals) {
      if (original.value === '') state.element.style.removeProperty(name)
      else state.element.style.setProperty(name, original.value, original.priority)
    }
  }
  const retire = key => {
    const state = applied.get(key)
    if (state) { restoreState(state); applied.delete(key) }
    const visual = visuals.get(key)
    if (visual) { visual.ghost?.remove(); visual.clone?.remove(); visual.marker?.remove(); visuals.delete(key) }
  }
  const clear = () => {
    for (const key of new Set([...applied.keys(), ...visuals.keys()])) retire(key)
  }
  const exactRoots = presentation => {
    const id = presentation.original.documentNodeId
    const component = editorDocument?.nodes?.[id]
    const primitive = editorDocument?.canvas?.elements?.find(candidate => candidate.id === id)
    const selector = component
      ? `[data-preview-instance="${id}"][data-preview-component="${component.componentId}"]:not([data-preview-flow-clone])`
      : primitive ? `[data-preview-canvas="${id}"][data-preview-kind="${primitive.kind}"]:not([data-preview-flow-clone])` : null
    if (!selector) return null
    const matches = [...container.querySelectorAll(selector)]
    if (matches.length !== 1 || !(matches[0] instanceof view.HTMLElement)) return null
    return { element: matches[0], component: Boolean(component), primitive }
  }
  const resolveExpectedOffsetParent = (presentation, roots) => {
    const pose = presentation.original.sourceOffsetParentPose
    if (!pose) return null
    if (pose.offsetParentNodeId === null) {
      if (!roots.component) return container
      const hosts = [...container.querySelectorAll('[data-preview-host]')]
      return hosts.length === 1 ? hosts[0] : null
    }
    const component = editorDocument?.nodes?.[pose.offsetParentNodeId]
    const primitive = editorDocument?.canvas?.elements?.find(candidate => candidate.id === pose.offsetParentNodeId)
    const selector = component
      ? `[data-preview-instance="${pose.offsetParentNodeId}"][data-preview-component="${component.componentId}"]`
      : primitive ? `[data-preview-canvas="${pose.offsetParentNodeId}"][data-preview-kind="${primitive.kind}"]` : null
    if (!selector) return null
    const matches = [...container.querySelectorAll(selector)]
    return matches.length === 1 ? matches[0] : null
  }
  const declarationsFor = (presentation, roots) => {
    const declarations = new Map()
    const dom = presentation.original.dom
    if (presentation.supportClone && presentation.movingVisual.kind === 'document-node') return declarations
    if (presentation.original.mode === 'flow') {
      declarations.set('opacity', { value: '0.6', priority: 'important' })
      return declarations
    }
    const pose = presentation.original.sourceOffsetParentPose
    const expectedOffsetParent = resolveExpectedOffsetParent(presentation, roots)
    if (!pose || !expectedOffsetParent || roots.element.offsetParent !== expectedOffsetParent) return null
    const { width, height } = presentation.original.current.semanticSize
    for (const [name, value] of [
      ['position', 'absolute'], ['left', '0px'], ['top', '0px'], ['width', `${width}px`], ['height', `${height}px`],
      ['box-sizing', 'border-box'], ['transform-origin', '0px 0px'], ['translate', 'none'], ['rotate', 'none'],
      ['scale', 'none'], ['transform', matrixText(pose.matrix)], ['will-change', 'transform'],
    ]) declarations.set(name, { value, priority: 'important' })
    if (dom.treatment === 'drag-elevated') {
      declarations.set('opacity', { value: '0.6', priority: '' })
      declarations.set('z-index', { value: '1000000', priority: '' })
    }
    return declarations
  }
  const captureDrift = state => {
    for (const [name, written] of state.written) {
      const current = read(state.element, name)
      if (!same(current, written)) state.originals.set(name, current)
    }
  }
  const stateFor = (key, roots) => {
    const existing = applied.get(key)
    if (existing?.element === roots.element) { captureDrift(existing); return existing }
    if (existing) retire(key)
    const state = { element: roots.element, originals: new Map(), written: new Map() }
    applied.set(key, state)
    return state
  }
  const write = (state, declarations) => {
    for (const name of state.written.keys()) if (!declarations.has(name)) {
      const original = state.originals.get(name)
      if (original.value === '') state.element.style.removeProperty(name)
      else state.element.style.setProperty(name, original.value, original.priority)
      state.written.delete(name)
      state.originals.delete(name)
    }
    for (const [name, declaration] of declarations) {
      if (!state.originals.has(name)) state.originals.set(name, read(state.element, name))
      const current = read(state.element, name)
      if (current.value !== declaration.value || current.priority !== declaration.priority) state.element.style.setProperty(name, declaration.value, declaration.priority)
      state.written.set(name, read(state.element, name))
    }
  }
  const syncVisual = (key, presentation) => {
    const visual = visuals.get(key) ?? { ghost: null, clone: null, marker: null }
    if (presentation.movingVisual.kind === 'fill-ghost' && !visual.ghost) {
      const ghost = ownerDocument.createElement('div')
      ghost.setAttribute('aria-hidden', 'true')
      ghost.setAttribute('data-preview-flow-ghost', '')
      ghost.tabIndex = -1
      for (const [name, value] of Object.entries({ position: 'absolute', left: '0px', top: '0px', pointerEvents: 'none', background: presentation.movingVisual.fill.color, opacity: String(presentation.movingVisual.fill.alpha), transformOrigin: '0 0', zIndex: '999999' })) ghost.style[name] = value
      container.append(ghost)
      visual.ghost = ghost
    } else if (presentation.movingVisual.kind !== 'fill-ghost' && visual.ghost) { visual.ghost.remove(); visual.ghost = null }
    if (presentation.supportClone && !visual.marker) {
      const marker = ownerDocument.createElement('span')
      marker.setAttribute('aria-hidden', 'true')
      marker.setAttribute('data-preview-flow-support-marker', '')
      marker.tabIndex = -1
      marker.inert = true
      Object.assign(marker.style, { position: 'absolute', width: '0px', height: '0px', overflow: 'hidden', pointerEvents: 'none', visibility: 'hidden' })
      container.append(marker)
      visual.marker = marker
    } else if (!presentation.supportClone && visual.marker) { visual.marker.remove(); visual.marker = null }
    visuals.set(key, visual)
    return visual
  }
  const syncClone = (visual, presentation, roots) => {
    if (presentation.supportClone && presentation.movingVisual.kind === 'document-node' && !visual.clone) {
      const clone = roots.element.cloneNode(true)
      if (clone instanceof view.HTMLElement) {
        stripDomIds(clone)
        clone.setAttribute('data-preview-flow-clone', '')
        clone.setAttribute('aria-hidden', 'true')
        clone.tabIndex = -1
        clone.inert = true
        Object.assign(clone.style, { position: 'absolute', left: '0px', top: '0px', margin: '0px', pointerEvents: 'none', transformOrigin: '0 0', zIndex: '1000000' })
        container.append(clone)
        visual.clone = clone
      }
    } else if ((!presentation.supportClone || presentation.movingVisual.kind !== 'document-node') && visual.clone) {
      visual.clone.remove()
      visual.clone = null
    }
  }
  const updateVisual = (visual, presentation) => {
    const element = visual.ghost ?? visual.clone
    if (!element) return
    const geometry = presentation.movingVisual.geometry
    const [topLeft, topRight, , bottomLeft] = geometry.quad
    const { width, height } = geometry.semanticSize
    const matrix = [(topRight.x - topLeft.x) / width, (topRight.y - topLeft.y) / width, (bottomLeft.x - topLeft.x) / height, (bottomLeft.y - topLeft.y) / height, topLeft.x, topLeft.y]
    element.style.width = `${width}px`
    element.style.height = `${height}px`
    element.style.transform = matrixText(matrix)
  }
  const apply = () => {
    if (applying) return
    applying = true
    try {
      const desired = new Set()
      for (const presentation of presentations) {
        const key = flowKey(presentation)
        desired.add(key)
        const roots = exactRoots(presentation)
        if (!roots) { retire(key); continue }
        const declarations = declarationsFor(presentation, roots)
        if (!declarations) { retire(key); continue }
        write(stateFor(key, roots), declarations)
        const visual = syncVisual(key, presentation)
        syncClone(visual, presentation, roots)
        updateVisual(visual, presentation)
      }
      for (const key of new Set([...applied.keys(), ...visuals.keys()])) if (!desired.has(key)) retire(key)
    } finally { applying = false }
  }
  const observer = new view.MutationObserver(apply)
  observer.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'data-preview-instance', 'data-preview-component', 'data-preview-canvas', 'data-preview-kind'] })

  return {
    update: next => { presentations = [...next]; apply() },
    setDocument: document => { editorDocument = document; apply() },
    reapply: apply,
    clear: () => { presentations = []; clear() },
    /** Removes the projection for a synchronous authoritative measurement and reapplies only if it remains active. */
    withoutOverlay: callback => { clear(); const result = callback(); apply(); return result },
    activeNodeIds: () => new Set(presentations.map(presentation => presentation.original.documentNodeId)),
    dispose: () => { observer.disconnect(); presentations = []; clear(); editorDocument = null },
  }
}
