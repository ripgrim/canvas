const attributeName = 'data-theme'
const read = (style, name) => ({ value: style.getPropertyValue(name), priority: style.getPropertyPriority(name) })

/**
 * Per-node theme layer beside the appearance and layout layers. For every component instance whose effective theme is
 * an explicit override it stamps `data-theme` and `color-scheme` on the single actual root (never a wrapper), remembering
 * the prior attribute and inline value with its priority so the root is restored exactly when the override changes, the
 * root is replaced, the document switches, or the layer stops. Portal roots registered by a verified adapter receive
 * their owner's effective theme (explicit or inherited) the same way; a root claimed by two owners with different themes
 * is reported as a conflict and left alone. Roots that cannot be resolved to one element are reported, not styled.
 */
export function createThemeLayer(ownerDocument) {
  const view = ownerDocument.defaultView
  const states = new Map()
  const reports = new Map()
  const portals = new Map()
  let editorDocument = null
  let active = false
  let unownedPortals = 0

  const restore = (element, state) => {
    if (state.attribute === null) element.removeAttribute(attributeName)
    else element.setAttribute(attributeName, state.attribute)
    if (state.scheme.value === '') element.style.removeProperty('color-scheme')
    else element.style.setProperty('color-scheme', state.scheme.value, state.scheme.priority)
  }
  const write = (element, key, theme) => {
    const state = states.get(element)
    if (state && state.key === key) return
    if (state) { restore(element, state); states.delete(element) }
    const next = { key, attribute: element.getAttribute(attributeName), scheme: read(element.style, 'color-scheme') }
    if (theme.attribute === null) element.removeAttribute(attributeName)
    else element.setAttribute(attributeName, theme.attribute)
    element.style.setProperty('color-scheme', theme.colorScheme, next.scheme.priority === 'important' ? 'important' : '')
    states.set(element, next)
  }
  const resolveRoots = () => {
    const roots = new Map()
    for (const element of ownerDocument.querySelectorAll('[data-preview-instance]')) {
      const id = element.getAttribute('data-preview-instance')
      const node = editorDocument && Object.hasOwn(editorDocument.nodes, id) ? editorDocument.nodes[id] : null
      if (!node || element.getAttribute('data-preview-component') !== node.componentId) continue
      roots.set(id, roots.has(id) ? null : element)
    }
    return roots
  }
  const keyOf = theme => `${theme.attribute ?? ''}|${theme.colorScheme}`
  const apply = () => {
    if (!active) return
    const roots = resolveRoots()
    const desired = new Map()
    reports.clear()
    for (const [id, node] of Object.entries(editorDocument?.nodes ?? {})) {
      if (!node.theme?.explicit) continue
      const element = roots.get(id)
      if (element === null) { reports.set(id, 'unsupported-ambiguous-root'); continue }
      if (!element) { reports.set(id, 'unsupported-no-root'); continue }
      desired.set(element, { key: keyOf(node.theme), theme: node.theme })
      reports.set(id, 'applied')
    }
    // Portal roots take their owner's effective theme; two owners with different themes make the root unsupported.
    const claims = new Map()
    for (const [root, owners] of portals) {
      const themes = [...owners].map(ownerId => editorDocument?.nodes[ownerId]?.theme).filter(Boolean)
      if (!themes.length || !root.isConnected) continue
      const keys = new Set(themes.map(keyOf))
      if (keys.size > 1) { for (const ownerId of owners) reports.set(ownerId, 'conflicting-portal'); continue }
      claims.set(root, { key: keyOf(themes[0]), theme: themes[0] })
    }
    for (const [root, claim] of claims) if (!desired.has(root)) desired.set(root, claim)
    for (const [element, state] of states) if (!desired.has(element)) { restore(element, state); states.delete(element) }
    for (const [element, { key, theme }] of desired) write(element, key, theme)
  }
  const observer = new view.MutationObserver(apply)
  const stop = () => {
    observer.disconnect()
    for (const [element, state] of states) restore(element, state)
    states.clear()
    reports.clear()
    portals.clear()
    unownedPortals = 0
    active = false
    editorDocument = null
  }
  return {
    start: () => {
      if (active) return
      active = true
      observer.observe(ownerDocument.body, { childList: true, subtree: true, attributes: true, attributeFilter: [attributeName, 'data-preview-instance', 'data-preview-component'] })
    },
    update: document => { editorDocument = document; apply() },
    apply,
    /**
     * A verified adapter maps a portal root to the preview instance that created it. The returned function withdraws the
     * claim and restores the root. DOM ancestry is never used to guess ownership.
     */
    registerPortalRoot: (instanceId, root, dispose) => {
      if (!(root instanceof view.Element)) throw new Error('A portal root must be an element')
      if (!portals.has(root)) portals.set(root, new Set())
      portals.get(root).add(instanceId)
      apply()
      return () => {
        const owners = portals.get(root)
        if (!owners) return
        owners.delete(instanceId)
        if (!owners.size) portals.delete(root)
        apply()
        if (typeof dispose === 'function') dispose()
      }
    },
    /** Portal-like roots that appeared outside the preview container without an owner claim (counted by the runtime). */
    reportUnownedPortals: count => { unownedPortals = count },
    report: () => ({ nodes: new Map(reports), unownedPortals, claims: [...portals.keys()] }),
    isClaimed: element => portals.has(element),
    stop,
    dispose: stop,
  }
}
