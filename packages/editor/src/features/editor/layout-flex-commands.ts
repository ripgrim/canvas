/**
 * Block and Flex container commands plus display conversions, attached to `documentStore.commands.layout`.
 * Every method is one semantic batch (one undo entry) across the given nodes and returns whether anything was
 * written. Measurements come from the caller (scene geometry), never from the DOM here.
 */
import type { FileCommand, FileNode } from '@canvas/repo-engine/file-document'
import type { ContentDistribution, CrossAlignment, DisplayMode, FlexContainer, FlexDirection, FlexItem, FlexWrap, LayoutContainer, LayoutGap, MainDistribution, NodeLayout } from '@canvas/repo-engine/layout'
import type { Rect } from './canvas-math'
import { convertDisplay } from './display-conversion'
import type { DisplayConversion } from './display-conversion'

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
  /** Converts containers to a display mode with the semantic child patches of the Wonder transitions (not a display-only write). */
  setDisplay: (display: DisplayMode, nodeIds: string[], measured: Record<string, MeasuredChildren>) => boolean
  /** What `setDisplay` would write for one container, including the `unsupported` note the inspector shows. Writes nothing. */
  displayConversion: (display: DisplayMode, nodeId: string, measured: MeasuredChildren | null) => DisplayConversion | null
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
 * have no cross-axis meaning and stay on the main axis. A value with no meaning on its new axis falls back to start:
 * stretch and baseline cannot become a main-axis position, and baseline has no column-family cross axis.
 */
export function redirectFlex(flex: FlexContainer, direction: FlexDirection): FlexContainer {
  if (rowFamily(flex.direction) === rowFamily(direction)) return { ...flex, direction }
  const crossFor = (value: CrossAlignment): CrossAlignment => value === 'baseline' && !rowFamily(direction) ? 'start' : value
  if (spaced(flex.justify)) return { ...flex, direction, align: crossFor(flex.align) }
  const justify: MainDistribution = flex.align === 'start' || flex.align === 'center' || flex.align === 'end' ? flex.align : 'start'
  return { ...flex, direction, justify, align: flex.justify as CrossAlignment }
}

const emptyFlowLayout: NodeLayout = { item: { position: { mode: 'flow' } } }
const canonical =(value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value
const sameValue = (left: unknown, right: unknown) => JSON.stringify(canonical(left ?? null)) === JSON.stringify(canonical(right ?? null))
const gapValid = (gap: LayoutGap) => typeof gap === 'number' ? Number.isFinite(gap) && gap >= 0 : Number.isFinite(gap.x) && Number.isFinite(gap.y) && gap.x >= 0 && gap.y >= 0
const flexValid = (flex: FlexItem) => (['grow', 'shrink'] as const).every(key => flex[key] === undefined || (Number.isFinite(flex[key]) && flex[key]! >= 0 && flex[key]! <= 1000))

export function createFlexCommands(context: LayoutCommandContext): FlexCommands {
  const component = (id: string) => { const node = context.node(id); return node?.type === 'component' ? node : null }
  const unique = (ids: readonly string[]) => [...new Set(ids)]
  const containerDisplay = (id: string | null) => (id ? component(id)?.layout?.container?.display : undefined) ?? null
  /** Writes only layouts that differ from the stored ones; nothing to write means no revision. */
  const write = (layouts: Map<string, NodeLayout>, extra: FileCommand[] = []) => {
    const commands: FileCommand[] = []
    // A node without a record already behaves as a plain flow item, so writing that record would be a no-op revision.
    for (const [nodeId, layout] of layouts) if (!sameValue(component(nodeId)?.layout ?? emptyFlowLayout, layout)) commands.push({ type: 'node.setLayout', nodeId, layout })
    return context.executeBatch([...commands, ...extra])
  }
  const editContainers = (nodeIds: readonly string[], accepts: (container: LayoutContainer) => boolean, edit: (container: LayoutContainer) => LayoutContainer | null) => {
    const layouts = new Map<string, NodeLayout>()
    for (const id of unique(nodeIds)) {
      const layout = component(id)?.layout
      if (!layout?.container || !accepts(layout.container)) continue
      const next = edit(layout.container)
      if (next) layouts.set(id, { ...layout, container: next })
    }
    return write(layouts)
  }
  const isFlex = (container: LayoutContainer) => container.display === 'flex' && Boolean(container.flex)
  const editFlex = (nodeIds: readonly string[], edit: (flex: FlexContainer) => FlexContainer) => editContainers(nodeIds, isFlex, container => ({ ...container, flex: edit(container.flex!) }))

  const conversionFor = (display: DisplayMode, nodeId: string, measured: MeasuredChildren | null, pending?: Map<string, NodeLayout>): DisplayConversion | null => {
    const node = component(nodeId)
    if (!node) return null
    const layoutOf = (id: string) => pending?.get(id) ?? component(id)?.layout
    const children = context.childrenOf(nodeId).filter(id => component(id)).map(id => ({ id, layout: layoutOf(id) }))
    const parentId = context.parentOf(nodeId)
    // A parent converted earlier in the same call already has its new display in `pending`.
    const parentDisplay = parentId && component(parentId) ? layoutOf(parentId)?.container?.display ?? null : null
    return convertDisplay({ container: { id: nodeId, layout: layoutOf(nodeId), parentDisplay }, children, measured, to: display })
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
      const reorders: FileCommand[] = []
      for (const id of unique(nodeIds)) {
        const conversion = conversionFor(display, id, measured[id] ?? null, pending)
        if (!conversion) continue
        for (const [nodeId, layout] of Object.entries(conversion.layouts)) pending.set(nodeId, layout)
        if (conversion.order) reorders.push(...reorderCommands(id, conversion.order))
      }
      return write(pending, reorders)
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
        const node = component(id)
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
