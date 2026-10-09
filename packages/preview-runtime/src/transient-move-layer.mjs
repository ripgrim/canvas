const selectorFor = nodeId => `[data-preview-instance="${nodeId}"], [data-preview-canvas="${nodeId}"]`

/**
 * Moves the mounted design root itself during a pointer gesture. The layer owns no DOM and restores the exact inline
 * translate declaration before layout, render, commit, or disposal can observe it.
 */
export function createTransientMoveLayer(ownerDocument, container) {
  const applied = new Map()
  let items = []

  const restore = nodeId => {
    const state = applied.get(nodeId)
    if (!state) return
    if (state.value) state.element.style.setProperty('translate', state.value, state.priority)
    else state.element.style.removeProperty('translate')
    applied.delete(nodeId)
  }
  const clear = () => { for (const nodeId of [...applied.keys()]) restore(nodeId) }
  const apply = () => {
    clear()
    for (const item of items) {
      const element = container.querySelector(selectorFor(item.nodeId))
      if (!(element instanceof ownerDocument.defaultView.HTMLElement)) continue
      const value = element.style.getPropertyValue('translate')
      const priority = element.style.getPropertyPriority('translate')
      const computed = ownerDocument.defaultView.getComputedStyle(element).translate
      applied.set(item.nodeId, { element, value, priority })
      const pixels = /^(-?\d+(?:\.\d+)?)px(?: (-?\d+(?:\.\d+)?)px)?$/.exec(computed)
      const x = item.dx + (pixels ? Number(pixels[1]) : 0)
      const y = item.dy + (pixels?.[2] ? Number(pixels[2]) : 0)
      element.style.setProperty('translate', `${x}px ${y}px`, 'important')
    }
  }

  return {
    update: next => { items = [...next]; apply() },
    reapply: apply,
    clear,
    dispose: () => { clear(); items = [] },
  }
}
