/**
 * Block and Flex container commands plus display conversions, attached to `documentStore.commands.layout`.
 * Every method is one semantic batch (one undo entry) across the given nodes and returns whether anything was
 * written. Measurements come from the caller (scene geometry), never from the DOM here.
 */
import { nodeChildDisplay, nodePositionMode } from '@canvas/repo-engine/file-document'
import type { FileCommand, FileNode, NodePrimitiveSize, NodeTextProperties } from '@canvas/repo-engine/file-document'
import type { ContentDistribution, CrossAlignment, DisplayMode, FlexContainer, FlexDirection, FlexItem, FlexWrap, LayoutContainer, LayoutGap, MainDistribution, NodeLayout } from '@canvas/repo-engine/layout'
import type { Rect } from './canvas-math'
import { convertDisplay } from './display-conversion'
import type { DisplayConversion, DisplayMeasurement } from './display-conversion'

/** What a command factory may use from the document store without owning it. */
export type LayoutCommandContext = {
  execute: (command: FileCommand, selection?: string[]) => boolean
  executeBatch: (commands: FileCommand[], selection?: string[]) => boolean
  node: (id: string) => FileNode | undefined
  parentOf: (id: string) => string | null
  isRootChild: (id: string) => boolean
  childrenOf: (parentId: string, slot?: string) => string[]
  /** The slot a child sits in, or null for page-root children. */
  slotOf: (id: string) => string | null
}
/**
 * Measured world rectangles of a container and its modeled children, as the preview last reported them. `border` is
 * the container's measured border widths (scene geometry `box.border`); conversions that place children by insets
 * or infer padding count from the padding edge when it is present.
 */
export type MeasuredChildren = { container: Rect | null; children: Record<string, Rect>; border?: { top: number; right: number; bottom: number; left: number } }

export type FlexCommands = {
  /** Converts containers with the exact measured child patches used by the Paper-compatible transition. */
  setDisplay: (display: DisplayMode, nodeIds: string[], measured: Record<string, DisplayMeasurement>) => boolean
  /** What `setDisplay` would write for one container, including the `unsupported` note the inspector shows. Writes nothing. */
  displayConversion: (display: DisplayMode, nodeId: string, measured: DisplayMeasurement | null) => DisplayConversion | null
  /** Direction change; switching between row and column swaps justify/align to keep the visual anchor, space distributions stay on the main axis. */
  setDirection: (direction: FlexDirection, nodeIds: string[]) => boolean
  setWrap: (wrap: FlexWrap, nodeIds: string[]) => boolean
  /** The 3 by 3 anchor control: main-axis distribution and cross-axis alignment together. */
  setAlignment: (alignment: { justify?: MainDistribution; align?: CrossAlignment }, nodeIds: string[]) => boolean
  setAlignContent: (value: ContentDistribution | null, nodeIds: string[]) => boolean
  /** Scalar or independent x/y gap; null clears. Applies to Flex and Grid containers (gap only exists in those modes). */
  setGap: (gap: LayoutGap | null, nodeIds: string[]) => boolean
  /** Applies to any node that already carries a container record. */
  setOverflow: (overflow: NonNullable<LayoutContainer['overflow']> | null, nodeIds: string[]) => boolean
  /** Child grow/shrink/basis; null clears the record. Only children of a Flex container change. */
  setItemFlex: (flex: FlexItem | null, nodeIds: string[]) => boolean
}

const rowFamily = (direction: FlexDirection) => direction === 'row' || direction === 'row-reverse'
const spaced = (justify: MainDistribution) => justify === 'space-between' || justify === 'space-around' || justify === 'space-evenly'
/**
 * Between the row and column families the anchor's axes trade places, so justify and align swap. Space distributions
 * have no cross-axis meaning and stay on the main axis. A value with no meaning on its new axis uses Paper's fallback:
 * stretch and first baseline become start, while last baseline becomes end when it moves to a column main axis.
 */
export function redirectFlex(flex: FlexContainer, direction: FlexDirection): FlexContainer {
  if (rowFamily(flex.direction) === rowFamily(direction)) return { ...flex, direction }
  const crossFor = (value: CrossAlignment): CrossAlignment => !rowFamily(direction) && (value === 'baseline' || value === 'last baseline') ? value === 'baseline' ? 'start' : 'end' : value
  if (spaced(flex.justify)) return { ...flex, direction, align: crossFor(flex.align) }
  const justify: MainDistribution = flex.align === 'last baseline' ? 'end' : flex.align === 'start' || flex.align === 'center' || flex.align === 'end' ? flex.align : 'start'
  return { ...flex, direction, justify, align: flex.justify as CrossAlignment }
}

const canonical =(value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value
const sameValue = (left: unknown, right: unknown) => JSON.stringify(canonical(left ?? null)) === JSON.stringify(canonical(right ?? null))
const gapValid = (gap: LayoutGap) => typeof gap === 'number' ? Number.isFinite(gap) && gap >= 0 : Number.isFinite(gap.x) && Number.isFinite(gap.y) && gap.x >= 0 && gap.y >= 0
const flexValid = (flex: FlexItem) => (['grow', 'shrink'] as const).every(key => flex[key] === undefined || (Number.isFinite(flex[key]) && flex[key]! >= 0 && flex[key]! <= 1000))

export function createFlexCommands(context: LayoutCommandContext): FlexCommands {
  const layoutNode = (id: string) => { const node = context.node(id); return node && node.type !== 'root' ? node : null }
  const containerNode = (id: string) => { const node = layoutNode(id); return node && (node.type === 'component' || node.type === 'frame') ? node : null }
  const defaultLayout = (node: Exclude<FileNode, { type: 'root' }>): NodeLayout => ({ item: { position: { mode: nodePositionMode(node)! } } })
  const layoutOf = (id: string, pending?: Map<string, NodeLayout>) => { const node = layoutNode(id); return pending?.get(id) ?? node?.layout ?? (node ? defaultLayout(node) : undefined) }
  const unique = (ids: readonly string[]) => [...new Set(ids)]
  const containerDisplay = (id: string | null) => { const node = id ? context.node(id) : undefined; return node ? nodeChildDisplay(node) : null }
  /** Writes only layouts that differ from the stored ones; nothing to write means no revision. */
  const write = (layouts: Map<string, NodeLayout>, primitiveSizes = new Map<string, NodePrimitiveSize>(), textProperties = new Map<string, NodeTextProperties>(), extra: FileCommand[] = []) => {
    const commands: FileCommand[] = []
    // Compare against the node kind's real absence default: components flow, while primitives remain freeform.
    for (const [nodeId, layout] of layouts) {
      const node = layoutNode(nodeId)
      if (node && !sameValue(node.layout ?? defaultLayout(node), layout)) commands.push({ type: 'node.setLayout', nodeId, layout })
    }
    for (const [nodeId, styles] of primitiveSizes) {
      const node = layoutNode(nodeId)
      if (node && node.type !== 'component' && !sameValue({ width: node.styles.width, height: node.styles.height }, styles)) commands.push({ type: 'node.setStyles', nodeId, styles })
    }
    for (const [nodeId, properties] of textProperties) {
      const node = layoutNode(nodeId)
      if (node?.type === 'text' && !sameValue({ textStyle: node.textStyle, textSizing: node.textSizing }, properties)) commands.push({ type: 'node.setTextProperties', nodeId, ...properties })
    }
    return context.executeBatch([...commands, ...extra])
  }
  const editContainers = (nodeIds: readonly string[], accepts: (container: LayoutContainer) => boolean, edit: (container: LayoutContainer) => LayoutContainer | null) => {
    const layouts = new Map<string, NodeLayout>()
    for (const id of unique(nodeIds)) {
      const layout = containerNode(id)?.layout
      if (!layout?.container || !accepts(layout.container)) continue
      const next = edit(layout.container)
      if (next) layouts.set(id, { ...layout, container: next })
    }
    return write(layouts)
  }
  const isFlex = (container: LayoutContainer) => container.display === 'flex' && Boolean(container.flex)
  const editFlex = (nodeIds: readonly string[], edit: (flex: FlexContainer) => FlexContainer) => editContainers(nodeIds, isFlex, container => ({ ...container, flex: edit(container.flex!) }))

  const conversionFor = (display: DisplayMode, nodeId: string, measured: DisplayMeasurement | null, pending?: Map<string, NodeLayout>): DisplayConversion | null => {
    const node = containerNode(nodeId)
    if (!node) return null
    const children = context.childrenOf(nodeId).flatMap(id => { const child = layoutNode(id); return child ? [{ id, layout: layoutOf(id, pending), defaultPosition: nodePositionMode(child)! }] : [] })
    const parentId = context.parentOf(nodeId)
    // A parent converted earlier in the same call already has its new display in `pending`.
    const parent = parentId ? context.node(parentId) : undefined
    const parentLayout = parentId ? pending?.get(parentId) ?? (parent && parent.type !== 'root' ? parent.layout : undefined) : undefined
    const parentDisplay = parent && parentId ? parentLayout?.container?.display ?? nodeChildDisplay(parent) : null
    const parentFlexDirection = parentDisplay === 'flex' ? parentLayout?.container?.flex?.direction : undefined
    return convertDisplay({ container: { id: nodeId, layout: layoutOf(nodeId, pending), defaultPosition: nodePositionMode(node)!, parentDisplay, hasNonRootParent: parentId !== null && !context.isRootChild(nodeId), ...(parentFlexDirection ? { parentFlexDirection } : {}) }, children, measured, to: display })
  }
  /**
   * Moving each node to the front of its own slot, last first, leaves every slot in the requested relative order
   * without knowing slot names or sizes (index 0 is valid in any slot).
   */
  const reorderCommands = (containerId: string, order: readonly string[]): FileCommand[] => {
    const current = context.childrenOf(containerId)
    const target = [...order.filter(id => current.includes(id)), ...current.filter(id => !order.includes(id))]
    if (target.every((id, index) => current[index] === id)) return []
    return [...target].reverse().map((nodeId): FileCommand => ({ type: 'node.reorder', nodeId, index: 0 }))
  }

  return {
    setDisplay: (display, nodeIds, measured) => {
      const pending = new Map<string, NodeLayout>()
      const primitiveSizes = new Map<string, NodePrimitiveSize>()
      const textProperties = new Map<string, NodeTextProperties>()
      const reorders: FileCommand[] = []
      for (const id of unique(nodeIds)) {
        const conversion = conversionFor(display, id, measured[id] ?? null, pending)
        if (!conversion) continue
        if (display === 'flex' && conversion.unsupported) return false
        for (const [nodeId, layout] of Object.entries(conversion.layouts)) pending.set(nodeId, layout)
        for (const [nodeId, styles] of Object.entries(conversion.primitiveSizes ?? {})) primitiveSizes.set(nodeId, styles)
        for (const [nodeId, properties] of Object.entries(conversion.textProperties ?? {})) textProperties.set(nodeId, properties)
        if (conversion.order) reorders.push(...reorderCommands(id, conversion.order))
      }
      return write(pending, primitiveSizes, textProperties, reorders)
    },
    displayConversion: (display, nodeId, measured) => conversionFor(display, nodeId, measured),
    setDirection: (direction, nodeIds) => editFlex(nodeIds, flex => redirectFlex(flex, direction)),
    setWrap: (wrap, nodeIds) => editFlex(nodeIds, flex => ({ ...flex, wrap })),
    setAlignment: (alignment, nodeIds) => editFlex(nodeIds, flex => ({ ...flex, ...(alignment.justify !== undefined ? { justify: alignment.justify } : {}), ...(alignment.align !== undefined ? { align: alignment.align } : {}) })),
    setAlignContent: (value, nodeIds) => editFlex(nodeIds, flex => { const next = { ...flex }; if (value === null) delete next.alignContent; else next.alignContent = value; return next }),
    setGap: (gap, nodeIds) => {
      if (gap !== null && !gapValid(gap)) return false
      return editContainers(nodeIds, container => isFlex(container) || container.display === 'grid', container => { const next = { ...container }; if (gap === null) delete next.gap; else next.gap = typeof gap === 'number' ? gap : { x: gap.x, y: gap.y }; return next })
    },
    setOverflow: (overflow, nodeIds) => editContainers(nodeIds, () => true, container => { const next = { ...container }; if (overflow === null) delete next.overflow; else next.overflow = overflow; return next }),
    setItemFlex: (flex, nodeIds) => {
      if (flex !== null && !flexValid(flex)) return false
      const layouts = new Map<string, NodeLayout>()
      for (const id of unique(nodeIds)) {
        const node = layoutNode(id)
        if (!node || containerDisplay(context.parentOf(id)) !== 'flex') continue
        if (!node.layout && flex === null) continue
        const layout = node.layout ?? { item: { position: { mode: 'flow' } } }
        const item = { ...layout.item }
        const record: FlexItem = flex === null ? {} : { ...(flex.grow !== undefined ? { grow: flex.grow } : {}), ...(flex.shrink !== undefined ? { shrink: flex.shrink } : {}), ...(flex.basis !== undefined ? { basis: flex.basis } : {}) }
        if (Object.keys(record).length) item.flex = record
        else delete item.flex
        layouts.set(id, { ...layout, item })
      }
      return write(layouts)
    },
  }
}
