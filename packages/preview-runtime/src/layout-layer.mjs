import { hostOrigin } from './scene-styles.mjs'
import { isContainerLonghand, layoutLonghands } from './layout-protocol.js'

const read = (style, name) => ({ value: style.getPropertyValue(name), priority: style.getPropertyPriority(name) })
const same = (left, right) => left.value === right.value && left.priority === right.priority

/**
 * Reversible layout layer for mounted component roots, the sibling of the appearance layer. It resolves exactly one
 * actual root element per node, writes layout longhands inline, remembers each controlled longhand's prior inline
 * value and priority per element, and restores them when the projection changes, the node unmounts, the document
 * switches, or the layer stops. It never inserts a wrapper. Container declarations only apply when every modeled
 * child is a real direct DOM child of the root; otherwise the node reports `unsupported-indirect-children` and
 * keeps the component's own layout. Stylesheet `!important` declarations on controlled longhands are reported.
 */
export function createLayoutLayer(ownerDocument, container) {
  const view = ownerDocument.defaultView
  const states = new Map()
  const reports = new Map()
  let editorDocument = null
  let items = []
  let transientBounds = new Map()
  let active = false
  let applying = false

  const restore = (element, state) => {
    for (const [name, original] of state.originals) {
      if (original === null) element.style.removeProperty(name)
      else element.style.setProperty(name, original.value, original.priority)
    }
  }
  // When the component itself rewrote a controlled longhand since the last write, that value becomes the one to restore.
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
  const write = (element, nodeId, declarations) => {
    const key = JSON.stringify(declarations)
    const state = states.get(element)
    if (state) {
      if (!drifted(element, state) && state.key === key && state.nodeId === nodeId) return
      restore(element, state)
      states.delete(element)
    }
    if (!declarations.length) return
    const next = { nodeId, key, originals: new Map(), written: new Map() }
    for (const [name] of declarations) { const before = read(element.style, name); next.originals.set(name, before.value === '' ? null : before) }
    for (const [name, value] of declarations) element.style.setProperty(name, value, next.originals.get(name)?.priority === 'important' ? 'important' : '')
    for (const [name] of declarations) next.written.set(name, read(element.style, name))
    states.set(element, next)
  }
  /** Stylesheet rules that match the element and declare a controlled longhand `!important` win over inline values. */
  const importantConflicts = (element, names) => {
    const conflicts = new Set()
    for (const sheet of ownerDocument.styleSheets) {
      let rules
      try { rules = sheet.cssRules } catch { continue }
      for (const rule of rules) {
        if (!rule.style || !rule.selectorText) continue
        let matches = false
        try { matches = element.matches(rule.selectorText) } catch { continue }
        if (!matches) continue
        for (const name of names) if (rule.style.getPropertyPriority(name) === 'important') conflicts.add(name)
      }
    }
    return [...conflicts].sort()
  }
  const resolveRoots = () => {
    const roots = new Map()
    for (const element of container.querySelectorAll('[data-preview-instance]')) {
      const id = element.getAttribute('data-preview-instance')
      const node = editorDocument && Object.hasOwn(editorDocument.nodes, id) ? editorDocument.nodes[id] : null
      if (!node || element.getAttribute('data-preview-component') !== node.componentId) continue
      roots.set(id, roots.has(id) ? null : element)
    }
    return roots
  }
  const locationsOf = () => {
    const locations = new Map(editorDocument?.rootIds.map((id, index) => [id, { parentId: null, slot: null, index }]) ?? [])
    for (const node of Object.values(editorDocument?.nodes ?? {})) for (const [slot, ids] of Object.entries(node.children)) ids.forEach((id, index) => locations.set(id, { parentId: node.id, slot, index }))
    return locations
  }
  /** Flow order inside the host and inside slots: the DOM order of the mounted roots is reassigned by document order. */
  const orderDeclarations = (entries, locations) => {
    const result = new Map()
    const parents = new Map()
    for (const entry of entries) {
      const parent = entry.element.parentElement
      if (!parents.has(parent)) parents.set(parent, [])
      parents.get(parent).push(entry)
    }
    for (const [parent, group] of parents) {
      const siblings = Array.from(parent.children)
      const domOrder = [...group].sort((left, right) => siblings.indexOf(left.element) - siblings.indexOf(right.element))
      const positions = new Map(domOrder.map((entry, index) => [entry.item.nodeId, index]))
      const slots = new Map()
      for (const entry of group) {
        const place = locations.get(entry.item.nodeId)
        const key = `${place?.parentId ?? 'root'}:${place?.slot ?? 'root'}`
        if (!slots.has(key)) slots.set(key, [])
        slots.get(key).push(entry)
      }
      for (const entry of group) result.set(entry.item.nodeId, String(positions.get(entry.item.nodeId)))
      for (const slot of slots.values()) {
        const available = slot.map(entry => positions.get(entry.item.nodeId)).sort((left, right) => left - right)
        slot.sort((left, right) => left.item.order - right.item.order).forEach((entry, index) => { result.set(entry.item.nodeId, String(available[index])) })
      }
    }
    return result
  }
  // Sizes written for Hug nodes whose children are all absolute; remembered so each apply writes every element once.
  const hugSizes = new Map()
  const number = text => Number.parseFloat(text) || 0
  const intrinsic = value => /^(fit|min|max)-content$/.test(value)
  const apply = () => {
    if (!active || applying) return
    applying = true
    try {
      const roots = resolveRoots()
      const locations = locationsOf()
      const origin = editorDocument ? hostOrigin(editorDocument.frame) : { x: 0, y: 0, width: 0 }
      const entries = []
      reports.clear()
      for (const item of items) {
        if (!editorDocument || !Object.hasOwn(editorDocument.nodes, item.nodeId)) continue
        const element = roots.get(item.nodeId)
        if (element === null) { reports.set(item.nodeId, { status: 'unsupported-ambiguous-root', conflicts: [] }); continue }
        if (!element) { reports.set(item.nodeId, { status: 'unsupported-no-root', conflicts: [] }); continue }
        entries.push({ item, element, isRoot: locations.get(item.nodeId)?.parentId === null })
      }
      // Nested absolute nodes position against their component parent's box, so a static parent becomes relative.
      const relativeParents = new Set()
      for (const { item, element, isRoot } of entries) {
        const parent = element.parentElement
        // A parent whose relative position this layer wrote reads as relative; it stays desired rather than restoring and re-applying forever.
        const ownedRelative = states.get(parent)?.written.get('position')?.value === 'relative'
        if (item.mode === 'absolute' && !isRoot && parent && parent !== container && (ownedRelative || relativeParents.has(parent) || view.getComputedStyle(parent).position === 'static')) relativeParents.add(parent)
      }
      const orders = orderDeclarations(entries, locations)
      const desired = new Map()
      const childrenOf = nodeId => Object.values(editorDocument.nodes[nodeId].children ?? {}).flat()
      for (const { item, element, isRoot } of entries) {
        const declarations = new Map()
        declarations.set('order', orders.get(item.nodeId))
        // Baked sizes are measured border boxes, so they apply as border boxes regardless of the component's own box-sizing.
        if (item.width !== undefined || item.height !== undefined) declarations.set('box-sizing', 'border-box')
        if (item.width !== undefined) { declarations.set('width', `${item.width}px`); declarations.set('flex', '0 0 auto') }
        if (item.height !== undefined) declarations.set('height', `${item.height}px`)
        if (item.mode === 'absolute') {
          declarations.set('position', 'absolute')
          // Authored insets (right/bottom/percent) arrive as longhands and replace the five-field left/top entirely.
          const authoredInsets = item.declarations && ['left', 'right', 'top', 'bottom'].some(name => Object.hasOwn(item.declarations, name))
          if (!authoredInsets) {
            declarations.set('left', `${isRoot ? item.x - origin.x : item.x}px`)
            declarations.set('top', `${isRoot ? item.y - origin.y : item.y}px`)
          }
          if (!item.declarations || !Object.hasOwn(item.declarations, 'transform')) declarations.set('transform', '')
        } else if (relativeParents.has(element)) declarations.set('position', 'relative')
        let status = 'applied'
        if (item.declarations) {
          const childIds = childrenOf(item.nodeId)
          const containerDeclarations = Object.entries(item.declarations).filter(([name]) => isContainerLonghand(name))
          const direct = childIds.every(childId => { const child = roots.get(childId); return Boolean(child) && child.parentElement === element })
          if (containerDeclarations.length && !direct) status = 'unsupported-indirect-children'
          for (const [name, value] of Object.entries(item.declarations)) {
            if (isContainerLonghand(name) && status !== 'applied') continue
            declarations.set(name, value)
          }
        }
        const transient = transientBounds.get(item.nodeId)
        if (transient?.width !== undefined || transient?.height !== undefined) declarations.set('box-sizing', 'border-box')
        if (transient?.width !== undefined) { declarations.set('width', `${transient.width}px`); declarations.set('flex', '0 0 auto') }
        if (transient?.height !== undefined) declarations.set('height', `${transient.height}px`)
        // Hug with only absolute children: CSS gives the box no content size, so the children's extent plus the
        // trailing padding and border becomes the size (observed Wonder rule, LAY-HUG-001). Last round's size applies now.
        const childIds = childrenOf(item.nodeId)
        const hug = ['width', 'height'].some(name => declarations.has(name) && intrinsic(declarations.get(name)))
        const absoluteOnly = childIds.length > 0 && childIds.every(childId => items.find(candidate => candidate.nodeId === childId)?.mode === 'absolute' && roots.get(childId))
        const remembered = hug && absoluteOnly ? hugSizes.get(item.nodeId) : undefined
        if (remembered) {
          declarations.set('box-sizing', 'border-box')
          for (const name of ['width', 'height']) if (remembered[name] !== undefined && declarations.has(name) && intrinsic(declarations.get(name))) declarations.set(name, `${remembered[name]}px`)
        }
        if (!(hug && absoluteOnly)) hugSizes.delete(item.nodeId)
        const list = [...declarations].filter(([, value]) => value !== undefined)
        desired.set(element, { nodeId: item.nodeId, declarations: list, hug: hug && absoluteOnly ? childIds : null })
        reports.set(item.nodeId, { status, conflicts: importantConflicts(element, list.map(([name]) => name)) })
      }
      for (const parent of relativeParents) if (!desired.has(parent)) desired.set(parent, { nodeId: null, declarations: [['position', 'relative']] })
      for (const [element, state] of states) if (!desired.has(element)) { restore(element, state); states.delete(element) }
      for (const [element, { nodeId, declarations }] of desired) write(element, nodeId, declarations)
      // Measure Hug extents now that children are placed; a changed size is written once more and remembered.
      for (const [element, { nodeId, declarations, hug }] of desired) {
        if (!hug) continue
        const style = view.getComputedStyle(element)
        const children = hug.map(childId => roots.get(childId))
        const authored = Object.fromEntries(items.find(candidate => candidate.nodeId === nodeId)?.declarations ? Object.entries(items.find(candidate => candidate.nodeId === nodeId).declarations) : [])
        const size = {}
        if (intrinsic(authored.width ?? '')) size.width = Math.round(number(style.borderLeftWidth) + Math.max(0, ...children.map(child => child.offsetLeft + child.offsetWidth)) + number(style.paddingRight) + number(style.borderRightWidth))
        if (intrinsic(authored.height ?? '')) size.height = Math.round(number(style.borderTopWidth) + Math.max(0, ...children.map(child => child.offsetTop + child.offsetHeight)) + number(style.paddingBottom) + number(style.borderBottomWidth))
        const previous = hugSizes.get(nodeId)
        if (previous && previous.width === size.width && previous.height === size.height) continue
        hugSizes.set(nodeId, size)
        const sized = declarations.map(([name, value]) => size[name] !== undefined && (intrinsic(value) || /px$/.test(value)) ? [name, `${size[name]}px`] : [name, value])
        if (!sized.some(([name]) => name === 'box-sizing')) sized.push(['box-sizing', 'border-box'])
        write(element, nodeId, sized)
      }
    } finally { applying = false }
  }
  const observer = new view.MutationObserver(apply)
  const stop = () => {
    observer.disconnect()
    for (const [element, state] of states) restore(element, state)
    states.clear()
    reports.clear()
    active = false
    editorDocument = null
    items = []
    transientBounds = new Map()
  }
  return {
    start: () => {
      if (active) return
      active = true
      observer.observe(ownerDocument.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-preview-instance', 'data-preview-component'] })
    },
    /** Replaces the document and the layout items, then reapplies; stale elements are restored first. */
    update: (document, nextItems) => { editorDocument = document; items = Array.isArray(nextItems) ? nextItems : []; apply() },
    setItems: nextItems => { items = Array.isArray(nextItems) ? nextItems : []; apply() },
    setTransientBounds: nextItems => {
      const next = new Map()
      for (const item of nextItems) if (item.width !== undefined || item.height !== undefined) next.set(item.nodeId, item)
      let unchanged = next.size === transientBounds.size
      for (const [nodeId, item] of next) {
        const previous = transientBounds.get(nodeId)
        if (previous?.width !== item.width || previous?.height !== item.height) { unchanged = false; break }
      }
      if (unchanged) return
      transientBounds = next
      apply()
    },
    apply,
    /** Per node: whether the projection applied and which controlled longhands a stylesheet forces with !important. */
    report: () => new Map([...reports].map(([id, value]) => [id, { status: value.status, conflicts: [...value.conflicts] }])),
    /** The longhands this layer may control; the geometry observer ignores mutations limited to them while applying. */
    longhands: layoutLonghands,
    stop,
    dispose: stop,
  }
}
