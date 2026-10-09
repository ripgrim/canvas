import { appearanceStyle } from './scene-styles.mjs'

const cssName = name => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`).replace(/^webkit-/, '-webkit-')
const read = (style, name) => ({ value: style.getPropertyValue(name), priority: style.getPropertyPriority(name) })
const same = (left, right) => left.value === right.value && left.priority === right.priority
function longhands(style) {
  const result = new Map()
  for (let index = 0; index < style.length; index += 1) { const name = style.item(index); result.set(name, read(style, name)) }
  return result
}

/**
 * Applies node appearance to mounted component roots as an inline style layer. The component element is never
 * wrapped, replaced, or re-keyed. Each controlled longhand's prior inline value and priority is remembered per
 * element and restored when the appearance disappears, changes, or the element stops being that node's root.
 * When the component itself rewrites a controlled property, its new value becomes the value to restore.
 */
export function createAppearanceLayer(ownerDocument) {
  const view = ownerDocument.defaultView
  const scratch = ownerDocument.createElement('div')
  const states = new Map()
  let editorDocument = null
  let active = false
  // Shorthands expand differently per engine, so the controlled longhands are read back from a detached element.
  const controlledLonghands = declarations => {
    scratch.removeAttribute('style')
    for (const [name, value] of declarations) scratch.style.setProperty(name, value)
    return [...longhands(scratch.style).keys()]
  }
  // CSSOM updates existing declarations in place, so restoring every controlled longhand reproduces the prior inline style text.
  const restore = (element, state) => {
    for (const [name, original] of state.originals) {
      if (original === null) element.style.removeProperty(name)
      else element.style.setProperty(name, original.value, original.priority)
    }
  }
  const drifted = (element, state) => {
    let changed = false
    for (const [name, written] of state.written) {
      const current = read(element.style, name)
      if (same(current, written)) continue
      state.originals.set(name, current.value === '' ? null : current)
      changed = true
    }
    return changed
  }
  const write = (element, nodeId, declarations, key) => {
    const state = states.get(element)
    if (state) {
      if (!drifted(element, state) && state.key === key && state.nodeId === nodeId) return
      restore(element, state)
      states.delete(element)
    }
    if (!declarations.length) return
    const controlled = controlledLonghands(declarations)
    const before = longhands(element.style)
    const next = { nodeId, key, originals: new Map(controlled.map(name => [name, before.get(name) ?? null])), written: new Map() }
    for (const [name, value] of declarations) element.style.setProperty(name, value)
    for (const name of controlled) next.written.set(name, read(element.style, name))
    states.set(element, next)
  }
  const apply = () => {
    if (!active) return
    const roots = new Map()
    for (const element of ownerDocument.querySelectorAll('[data-preview-instance]')) {
      const id = element.getAttribute('data-preview-instance')
      const node = editorDocument && Object.hasOwn(editorDocument.nodes, id) ? editorDocument.nodes[id] : null
      if (!node?.appearance || element.getAttribute('data-preview-component') !== node.componentId) continue
      roots.set(id, roots.has(id) ? null : { element, node })
    }
    const desired = new Map()
    for (const [id, root] of roots) {
      // An instance id on more than one element has no single root to style.
      if (!root) continue
      const declarations = Object.entries(appearanceStyle(root.node.appearance, editorDocument.assets, 'component')).map(([name, value]) => [cssName(name), value])
      desired.set(root.element, { nodeId: id, declarations, key: JSON.stringify(declarations) })
    }
    for (const [element, state] of states) if (!desired.has(element)) { restore(element, state); states.delete(element) }
    for (const [element, { nodeId, declarations, key }] of desired) write(element, nodeId, declarations, key)
  }
  const observer = new view.MutationObserver(apply)
  const stop = () => {
    observer.disconnect()
    for (const [element, state] of states) restore(element, state)
    states.clear()
    active = false
    editorDocument = null
  }
  return {
    start: () => {
      if (active) return
      active = true
      observer.observe(ownerDocument.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-preview-instance', 'data-preview-component'] })
    },
    update: document => { editorDocument = document; apply() },
    apply,
    stop,
    dispose: stop,
  }
}
