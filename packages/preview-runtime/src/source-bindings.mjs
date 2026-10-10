import React, { useState, useSyncExternalStore } from 'react'

const empty = Object.freeze({ baseline: null, document: null })
let snapshot = empty
const listeners = new Set()
const components = new Map()
const registryComponents = new Map()
const sourceComponent = Symbol('design-editor-source-component')
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
const getSnapshot = () => snapshot
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

export function configureSourceBindings(baseline, registry = []) {
  registryComponents.clear()
  for (const binding of registry) if (binding && typeof binding.componentId === 'string' && typeof binding.Component === 'function') registryComponents.set(binding.componentId, binding.Component[sourceComponent] ?? binding.Component)
  snapshot = { baseline: structuredClone(baseline), document: structuredClone(baseline) }
}

export function applySourceDocument(document) {
  const baseline = snapshot.baseline
  if (!baseline) throw new Error('Source bindings are not configured. The running application is retained.')
  for (const [id, original] of Object.entries(baseline.nodes)) {
    const next = document.nodes[id]
    if (next && (next.componentId !== original.componentId || next.exportName !== original.exportName)) throw new Error('A source-bound component changed identity. The running application is retained.')
  }
  snapshot = { baseline, document: structuredClone(document) }
  for (const listener of listeners) listener()
}

function findInstance(componentId, props, baseline) {
  if (!baseline) return null
  const explicit = props['data-preview-instance']
  if (typeof explicit === 'string' && baseline.nodes[explicit]?.componentId === componentId) return explicit
  const candidates = Object.values(baseline.nodes).filter(node => node.componentId === componentId)
  const matches = candidates.filter(node => {
    const identity = ['id', 'name', 'htmlFor'].filter(name => Object.hasOwn(node.props, name))
    if (identity.length) return identity.every(name => props[name] === node.props[name])
    if (typeof node.props.children === 'string') return props.children === node.props.children
    return candidates.length === 1
  })
  return matches.length === 1 ? matches[0].id : null
}

function locations(document) {
  const result = new Map(document.rootIds.map((id, index) => [id, { parentId: null, slot: null, index }]))
  for (const node of Object.values(document.nodes)) for (const [slot, ids] of Object.entries(node.children)) ids.forEach((id, index) => result.set(id, { parentId: node.id, slot, index }))
  return result
}

function renderDetached(document, id) {
  const node = document.nodes[id]
  // Transformed source modules register their original export. The verified runtime registry is the fallback for a
  // source module that was imported but did not execute a bound instance in the baseline tree.
  const Component = node && (components.get(node.componentId) ?? registryComponents.get(node.componentId))
  if (!node || !Component) return null
  const slots = Object.fromEntries(Object.entries(node.children).filter(([, ids]) => ids.length).map(([slot, ids]) => [slot, ids.map(child => renderDetached(document, child))]))
  return React.createElement(Component, { ...node.props, ...slots, key: node.id, 'data-preview-instance': node.id, 'data-preview-component': node.componentId })
}

function extrasFor(instanceId, baseline, document) {
  const before = locations(baseline)
  const after = locations(document)
  const own = after.get(instanceId)
  if (!own) return []
  const siblings = own.parentId === null ? document.rootIds : document.nodes[own.parentId]?.children[own.slot] ?? []
  const anchors = siblings.filter(id => { const place = before.get(id); return place && place.parentId === own.parentId && place.slot === own.slot })
  if (!anchors.includes(instanceId)) return []
  return siblings.filter(id => {
    const place = before.get(id)
    if (place && place.parentId === own.parentId && place.slot === own.slot) return false
    const index = siblings.indexOf(id)
    const anchor = [...anchors].sort((left, right) => Math.abs(siblings.indexOf(left) - index) - Math.abs(siblings.indexOf(right) - index))[0]
    return anchor === instanceId
  })
}

export function bindSourceComponent(componentId, exportName, Component) {
  components.set(componentId, Component)
  function BoundComponent(props) {
    const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    const [instanceId] = useState(() => findInstance(componentId, props, current.baseline))
    const original = instanceId && current.baseline?.nodes[instanceId]
    const node = instanceId && current.document?.nodes[instanceId]
    if (!original) return React.createElement(Component, props)
    const next = { ...props }
    for (const name of new Set([...Object.keys(original.props), ...Object.keys(node?.props ?? {})])) {
      if (!node) break
      if (Object.hasOwn(node.props, name)) {
        if (!Object.hasOwn(original.props, name) || node.props[name] !== original.props[name]) next[name] = node.props[name]
      } else delete next[name]
    }
    if (node) {
      for (const [slot, ids] of Object.entries(node.children)) if (!(original.children[slot]?.length ?? 0) && ids.length) next[slot] = ids.map(id => renderDetached(current.document, id))
      next['data-preview-instance'] = instanceId
      next['data-preview-component'] = componentId
    }
    const before = locations(current.baseline).get(instanceId)
    const after = locations(current.document).get(instanceId)
    const retained = node && before && after && before.parentId === after.parentId && before.slot === after.slot
    const extras = extrasFor(instanceId, current.baseline, current.document).map(id => renderDetached(current.document, id))
    return React.createElement(React.Fragment, null, retained ? React.createElement(Component, { ...next, key: instanceId }) : null, ...extras)
  }
  Object.defineProperty(BoundComponent, 'name', { value: exportName })
  Object.defineProperty(BoundComponent, sourceComponent, { value: Component })
  return BoundComponent
}

export function disposeSourceBindings() {
  snapshot = empty
  listeners.clear()
  registryComponents.clear()
}
