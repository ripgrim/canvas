import { configureSourceBindings, applySourceDocument, disposeSourceBindings } from './source-bindings.mjs'
import { createGeometryObserver } from './geometry-observer.mjs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { acceptPreviewCommand, isPreviewDocument } from './protocol.js'
import { canvasElementStyle, hostOrigin } from './scene-styles.mjs'
import { createAppearanceLayer } from './appearance-layer.mjs'
import { createLayoutLayer } from './layout-layer.mjs'
import { createThemeLayer } from './theme-layer.mjs'
import { applyPageBackground } from './page-background.mjs'
import { createTransientMoveLayer } from './transient-move-layer.mjs'
export { appearanceStyle, canvasElementStyle, fillLayers, hostOrigin, legacyTextColor } from './scene-styles.mjs'
export { createAppearanceLayer } from './appearance-layer.mjs'
export { createLayoutLayer } from './layout-layer.mjs'
export { createThemeLayer } from './theme-layer.mjs'
export { applyPageBackground } from './page-background.mjs'
export { createTransientMoveLayer } from './transient-move-layer.mjs'

export function createSelectionDecorations(ownerDocument) {
  const marked = new Set()
  const stylesheet = ownerDocument.createElement('style')
  stylesheet.setAttribute('data-preview-selection-style', '')
  let active = false
  let currentDocument = null
  let currentNodeIds = []
  let currentColor = null
  const clear = () => { for (const element of marked) element.removeAttribute('data-preview-selected'); marked.clear() }
  const paint = () => {
    clear()
    if (!active || !currentDocument || typeof currentColor !== 'string' || currentColor.length !== 7 || !/^#[0-9a-fA-F]{6}$/.test(currentColor)) return
    const selectedIds = new Set(currentNodeIds)
    for (const element of ownerDocument.querySelectorAll('[data-preview-instance]')) {
      const id = element.getAttribute('data-preview-instance')
      const node = currentDocument.nodes[id]
      if (selectedIds.has(id) && node && element.getAttribute('data-preview-component') === node.componentId) { element.setAttribute('data-preview-selected', 'true'); marked.add(element) }
    }
  }
  const observer = new ownerDocument.defaultView.MutationObserver(paint)
  const stop = () => { observer.disconnect(); clear(); stylesheet.remove(); active = false; currentDocument = null; currentNodeIds = []; currentColor = null }
  return {
    start: () => {
      if (active) return
      ownerDocument.head.append(stylesheet)
      active = true
      observer.observe(ownerDocument.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-preview-instance', 'data-preview-component'] })
    },
    update: (editorDocument, nodeIds, color) => {
      currentDocument = editorDocument
      currentNodeIds = [...nodeIds]
      currentColor = color
      stylesheet.textContent = editorDocument && typeof color === 'string' && color.length === 7 && /^#[0-9a-fA-F]{6}$/.test(color) ? `:root { --design-editor-selection-color: ${color}; } [data-preview-instance][data-preview-selected="true"] { outline: 2px solid var(--design-editor-selection-color); outline-offset: 2px; }` : ''
      paint()
    },
    stop,
    dispose: stop,
  }
}

function renderCanvasTree(elements, parentId, offset, assets) {
  return elements.filter(element => element.parentId === parentId).map(element => {
    const children = element.kind === 'frame' ? renderCanvasTree(elements, element.id, { x: 0, y: 0 }, assets) : element.kind === 'text' ? element.text : null
    return React.createElement('div', { key: element.id, 'data-preview-canvas': element.id, 'data-preview-kind': element.kind, 'aria-hidden': 'true', style: canvasElementStyle(element, assets, offset) }, children)
  })
}

/**
 * `themeAdapters` are verified adapters for imported providers and portals: each may wrap an instance's React children
 * in a provider boundary (no DOM node) for the components it claims, and may register portal roots it can attribute to
 * an instance. Nothing else about providers or portals is inferred.
 */
export function startPreview({ Component, Provider, providerProps, initialProps, generation, editorOrigin, componentId, registry = [], sourceDocument = null, themeAdapters = [] }) {
  const container = document.getElementById('preview-root')
  let props = initialProps
  if (sourceDocument && !isPreviewDocument(sourceDocument, registry)) throw new Error('Invalid source binding document')
  if (sourceDocument) configureSourceBindings(sourceDocument, registry)
  let editorDocument = sourceDocument
  let interactionMode = 'interact'
  let selectedNodeIds = []
  let selectionColor = null
  let renderChrome = true
  let layoutItems = []
  let transientMoves = []
  let camera = { x: 0, y: 0, zoom: 1, width: window.innerWidth, height: window.innerHeight }
  let disposed = false
  let failed = false
  const send = (type, payload) => window.parent.postMessage({ channel: 'design-editor-preview', version: 3, generation, type, ...payload }, editorOrigin)
  const root = createRoot(container, { onUncaughtError: error => { failed = true; send('diagnostic', { message: String(error).slice(0, 4000) }) } })
  const bindings = new Map(registry.map(binding => [binding.componentId, binding]))
  // Placement and layout longhands are a reversible inline layer on the actual component roots (never a wrapper).
  const layoutLayer = createLayoutLayer(document, container)
  const transientMoveLayer = createTransientMoveLayer(document, container)
  let layoutGeneration = 0
  // The iframe is an implementation detail of the editor canvas: it paints no sheet of its own.
  for (const element of [document.documentElement, document.body]) Object.assign(element.style, { margin: '0', background: 'transparent', overflow: 'hidden', width: '100%', height: '100%' })
  Object.assign(container.style, { position: 'absolute', left: '50%', top: '50%', width: '0', height: '0', overflow: 'visible', transformOrigin: '0 0' })
  const applyCamera = () => { container.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }
  applyCamera()
  const selectionDecorations = createSelectionDecorations(document)
  selectionDecorations.start()
  // Appearance is an inline style layer; selection chrome is a stylesheet rule, so the two stay separate.
  const appearanceLayer = createAppearanceLayer(document)
  appearanceLayer.start()
  layoutLayer.start()
  const themeLayer = createThemeLayer(document)
  themeLayer.start()
  const geometry = createGeometryObserver(container, payload => send('geometry', payload), () => ({ ...camera }), () => ({ report: layoutLayer.report(), layoutGeneration, theme: themeLayer.report() }))
  // Elements appended beside the preview container (the usual portal target) without an owner claim are counted, never guessed.
  const countUnownedPortals = () => {
    const strays = [...document.body.children].filter(element => element !== container && element.tagName !== 'SCRIPT' && element.tagName !== 'STYLE' && !element.hasAttribute('data-preview-selection-style') && !themeLayer.isClaimed(element))
    themeLayer.reportUnownedPortals(strays.length)
    geometry.refresh()
  }
  // A claim can appear, conflict or go without any body mutation, so every claim change recounts and republishes.
  const registerPortalRoot = (instanceId, root, dispose) => {
    const release = themeLayer.registerPortalRoot(instanceId, root, dispose)
    countUnownedPortals()
    return () => { release(); countUnownedPortals() }
  }
  const adapters = Array.isArray(themeAdapters) ? themeAdapters.filter(adapter => adapter && typeof adapter.id === 'string') : []
  const adapterFor = instanceComponentId => adapters.find(adapter => Array.isArray(adapter.components) && adapter.components.includes(instanceComponentId)) ?? null
  const adapterDisposers = []
  for (const adapter of adapters) if (typeof adapter.install === 'function') { const dispose = adapter.install({ registerPortalRoot }); if (typeof dispose === 'function') adapterDisposers.push(dispose) }
  const portalWatch = new MutationObserver(countUnownedPortals)
  portalWatch.observe(document.body, { childList: true })
  geometry.update(editorDocument, null, componentId)
  geometry.start()
  const renderNode = id => {
    const node = editorDocument.nodes[id]
    const binding = bindings.get(node.componentId)
    const slots = Object.fromEntries(Object.entries(node.children).filter(([, children]) => children.length > 0).map(([slot, children]) => [slot, children.map(renderNode)]))
    const element = React.createElement(binding.Component, { ...node.props, ...slots, key: node.id, 'data-preview-instance': node.id, 'data-preview-component': node.componentId })
    const adapter = adapterFor(node.componentId)
    // A verified provider boundary wraps React children only; it never adds a DOM node around the actual root.
    return adapter && typeof adapter.renderBoundary === 'function' && node.theme ? React.createElement(React.Fragment, { key: node.id }, adapter.renderBoundary({ instanceId: node.id, theme: node.theme, children: element })) : element
  }
  const render = () => {
    transientMoveLayer.clear()
    applyPageBackground(document, editorDocument?.background)
    const component = editorDocument && !sourceDocument ? editorDocument.rootIds.map(renderNode) : React.createElement(Component, props)
    const content = Provider ? React.createElement(Provider, providerProps, component) : component
    const frame = editorDocument?.frame
    const origin = frame ? hostOrigin(frame) : { x: 0, y: 0, width: 0 }
    const hostStyle = frame
      ? { position: 'absolute', left: `${origin.x}px`, top: `${origin.y}px`, width: `${origin.width}px`, display: 'flex', flexDirection: frame.direction, gap: `${frame.gap}px`, boxSizing: 'border-box' }
      : { position: 'absolute', left: '0px', top: '0px' }
    const host = React.createElement('div', { key: 'host', 'data-preview-host': '', style: hostStyle }, content)
    const scene = editorDocument?.canvas ? renderCanvasTree(editorDocument.canvas.elements, null, { x: 0, y: 0 }, editorDocument.assets) : []
    flushSync(() => root.render(React.createElement(React.Fragment, null, host, ...scene)))
    layoutLayer.update(editorDocument, layoutItems)
    appearanceLayer.update(editorDocument)
    themeLayer.update(editorDocument)
    transientMoveLayer.reapply()
    selectedNodeIds = selectedNodeIds.filter(id => editorDocument && (Object.hasOwn(editorDocument.nodes, id) || editorDocument.canvas?.elements.some(element => element.id === id)))
    selectionDecorations.update(editorDocument, renderChrome ? selectedNodeIds : [], selectionColor); geometry.update(editorDocument, null, componentId)
  }
  // The design theme is applied exactly as the design declares it: an attribute on the document root plus the matching color-scheme.
  const setTheme = theme => { if (theme.attribute === null) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme.attribute; document.documentElement.style.colorScheme = theme.colorScheme }
  const receive = event => {
    const command = acceptPreviewCommand(event, editorOrigin, window.parent, generation, editorDocument)
    if (!command || disposed) return
    if (command.type === 'dispose') dispose()
    else if (command.type === 'ping' && !failed) { if (sourceDocument) send('source-bindings', { instanceIds: Object.keys(sourceDocument.nodes) }); send('ready', { componentId }); geometry.refresh() }
    else if (command.type === 'ping') return
    else if (command.type === 'set-theme') { setTheme(command.theme); geometry.refresh() }
    else if (command.type === 'set-interaction-mode') interactionMode = command.mode
    else if (command.type === 'set-camera') { camera = { ...command.camera }; applyCamera(); geometry.refresh() }
    else if (command.type === 'set-layout') { geometry.suspend(); transientMoveLayer.clear(); layoutItems = command.items; layoutGeneration = command.layoutGeneration; layoutLayer.setItems(layoutItems); appearanceLayer.apply(); transientMoveLayer.reapply(); if (!transientMoves.length) geometry.resume() }
    else if (command.type === 'set-transient-move') { transientMoves = command.items; if (transientMoves.length) geometry.suspend(); transientMoveLayer.update(transientMoves); if (!transientMoves.length) geometry.resume() }
    else if (command.type === 'set-selection') { selectedNodeIds = [...command.nodeIds]; renderChrome = command.renderChrome !== false; selectionColor = command.color; selectionDecorations.update(editorDocument, renderChrome ? selectedNodeIds : [], selectionColor); geometry.update(editorDocument, null, componentId) }
    else if (command.type === 'set-document') {
      if (!isPreviewDocument(command.document, registry)) { send('diagnostic', { message: 'Component binding needs review. The last preview is retained.' }); return }
      // The incoming document is the authoritative pointer-up result. Drop the visual offset before rendering it so
      // the committed geometry is never translated twice while the editor's clear message follows.
      transientMoves = []
      transientMoveLayer.clear()
      if (sourceDocument) {
        try { flushSync(() => applySourceDocument(command.document)) }
        catch (error) { send('diagnostic', { message: String(error.message).slice(0, 4000) }); return }
      }
      editorDocument = command.document
      if (command.theme) setTheme(command.theme)
      render()
    }
    else if (!editorDocument) { props = command.props; render() }
    else send('diagnostic', { message: 'Edit document instance props through the component inspector.' })
  }
  const selected = event => {
    if (interactionMode !== 'interact') { event.preventDefault(); event.stopImmediatePropagation() }
    if (interactionMode === 'pan') return
    const target = event.target instanceof Element ? event.target.closest('[data-preview-instance]') : null
    const instanceId = target?.getAttribute('data-preview-instance')
    const node = instanceId && editorDocument?.nodes[instanceId]
    const bounds = (node ? target : container).getBoundingClientRect()
    send('selected', { componentId: node ? node.componentId : componentId, ...(node ? { instanceId } : {}), bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } })
  }
  const suppressInteraction = event => {
    if (interactionMode !== 'interact' && !(event.type === 'keydown' && event.key === 'Tab')) { event.preventDefault(); event.stopImmediatePropagation() }
  }
  // Wheel input over the running component still belongs to the editor camera.
  const forwardWheel = event => {
    event.preventDefault()
    send('wheel', { wheel: { deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, clientX: event.clientX, clientY: event.clientY } })
  }
  const diagnostic = event => send('diagnostic', { message: String(event.message || event.reason || 'Preview failed').slice(0, 4000) })
  const dispose = () => {
    if (disposed) return
    disposed = true
    geometry.dispose()
    selectionDecorations.dispose()
    appearanceLayer.dispose()
    transientMoveLayer.dispose()
    layoutLayer.dispose()
    portalWatch.disconnect()
    for (const dispose of adapterDisposers) { try { dispose() } catch { /* an adapter that fails to dispose cannot block the preview from disposing */ } }
    themeLayer.dispose()
    root.unmount()
    if (sourceDocument) disposeSourceBindings()
    window.removeEventListener('message', receive)
    window.removeEventListener('error', diagnostic)
    window.removeEventListener('unhandledrejection', diagnostic)
    window.removeEventListener('pagehide', dispose)
    window.removeEventListener('wheel', forwardWheel)
    document.removeEventListener('pointerdown', selected, true)
    document.removeEventListener('click', suppressInteraction, true)
    document.removeEventListener('keydown', suppressInteraction, true)
    document.removeEventListener('beforeinput', suppressInteraction, true)
  }
  window.addEventListener('message', receive)
  window.addEventListener('error', diagnostic)
  window.addEventListener('unhandledrejection', diagnostic)
  window.addEventListener('pagehide', dispose)
  window.addEventListener('wheel', forwardWheel, { passive: false })
  document.addEventListener('pointerdown', selected, true)
  document.addEventListener('click', suppressInteraction, true)
  document.addEventListener('keydown', suppressInteraction, true)
  document.addEventListener('beforeinput', suppressInteraction, true)
  render()
  requestAnimationFrame(() => { if (!disposed && !failed) { if (sourceDocument) send('source-bindings', { instanceIds: Object.keys(sourceDocument.nodes) }); send('ready', { componentId }) } })
  return { dispose }
}
