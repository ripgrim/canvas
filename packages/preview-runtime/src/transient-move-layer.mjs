import { fillGeometryStyle } from './scene-styles.mjs'

const selectorFor = nodeId => `[data-preview-instance="${nodeId}"], [data-preview-canvas="${nodeId}"]`
const cssName = name => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`).replace(/^webkit-/, '-webkit-')

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
    for (const property of state.originals.keys()) restoreProperty(state, property)
    applied.delete(nodeId)
  }
  const clear = () => {
    for (const state of applied.values()) for (const property of state.originals.keys()) restoreProperty(state, property)
    applied.clear()
  }
  const stateFor = item => {
    const existing = applied.get(item.nodeId)
    if (existing) return existing
    const element = container.querySelector(selectorFor(item.nodeId))
    if (!(element instanceof ownerDocument.defaultView.HTMLElement)) return null
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
