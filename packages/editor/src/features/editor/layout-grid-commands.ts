/**
 * Grid container and placement commands, attached as `documentStore.commands.layout.grid`. Every method is one
 * semantic batch (one undo entry) and returns whether anything was written. Track edits repair children atomically;
 * manual/auto switches use measured occupancy supplied by the caller. Nodes that are not Grid containers (or not
 * children of one, for item commands) are skipped.
 */
import type { FileCommand, FileNode } from '@canvas/repo-engine/file-document'
import { findPlacementOrder, minimumTracks as requiredTracks, placeGridItems, remapStartAfterTrackMove, repairAfterTrackRemoval } from '@canvas/repo-engine/grid-placement'
import type { GridCell as GridArea, GridPlacementInput, GridPlacementOptions } from '@canvas/repo-engine/grid-placement'
import { fr, validateGridTrack } from '@canvas/repo-engine/grid-tracks'
import type { GridTrack } from '@canvas/repo-engine/grid-tracks'
import { contentDistributions, itemAlignments, maxGridLine, maxGridTracks } from '@canvas/repo-engine/layout'
import type { ContentDistribution, GridContainer, GridItem, ItemAlignment, NodeLayout } from '@canvas/repo-engine/layout'
import type { PreviewGridMeasure, PreviewSides } from '@canvas/preview-runtime/protocol'
import type { Rect } from './canvas-math'
import { gridOverlay } from './grid-overlay'
import type { GridTrackSpan } from './grid-overlay'
import type { LayoutCommandContext } from './layout-flex-commands'

export type GridAxis = 'columns' | 'rows'
/**
 * Measured container box, resolved tracks and child rectangles, as the preview last reported them. `border` is the
 * container's measured border (scene geometry `box.border`, zero when absent). `distribution` is the content
 * alignment the overlay should model track offsets with; the measurement has no track offsets, so the commands fill
 * it from the authored container when the caller leaves it out (see grid-overlay.ts).
 */
export type MeasuredGrid = { container: Rect; grid: PreviewGridMeasure; children: Record<string, Rect>; border?: PreviewSides; distribution?: { justifyContent?: ContentDistribution | undefined; alignContent?: ContentDistribution | undefined } }
export type GridCell = { column: number; row: number }
/** Nearest cells for the in-flow children of a measured Grid, and the children that have no supported position. */
export type MeasuredCells = { cells: Record<string, GridCell>; unsupported: string[] }

export type GridCommands = {
  setTracks: (axis: GridAxis, tracks: GridTrack[], nodeIds: string[]) => boolean
  /** Appends a `1fr` track. */
  addTrack: (axis: GridAxis, nodeIds: string[]) => boolean
  /** Removes track `index` (one-based); refused below the minimum the children need; shifts, clamps and shrinks child placement in the same batch. */
  removeTrack: (axis: GridAxis, index: number, nodeIds: string[]) => boolean
  /** Moves track `from` to `to` (one-based); explicit starts remap and auto children may reorder to keep their occupied areas. */
  moveTrack: (axis: GridAxis, from: number, to: number, nodeIds: string[]) => boolean
  setAutoFlow: (autoFlow: 'row' | 'column', nodeIds: string[]) => boolean
  setAlignment: (alignment: { justifyItems?: ItemAlignment | null; alignItems?: ItemAlignment | null; justifyContent?: ContentDistribution | null; alignContent?: ContentDistribution | null }, nodeIds: string[]) => boolean
  /** Child placement: starts, spans and self alignment; omitted keys stay, null keys clear. */
  setPlacement: (placement: { [K in keyof GridItem]?: GridItem[K] | null }, nodeIds: string[]) => boolean
  /** A Grid is manual when any in-flow child has an explicit start. */
  isManual: (containerId: string) => boolean
  /**
   * Manual writes the nearest measured cell to every in-flow child that has one (spans kept); children without a
   * measured rectangle or lying outside every track are skipped, and `measureCells` lists them for the caller to
   * report. Auto clears starts only when a sibling order reproduces the current occupancy, applying that order in the
   * same batch; otherwise nothing is written.
   */
  setManual: (containerId: string, manual: boolean, measured: MeasuredGrid | null) => boolean
  /** Drop of a child onto a measured cell (drag target). */
  moveToCell: (childId: string, cell: GridCell) => boolean
  /** Minimum track count an axis needs for the current children. */
  minimumTracks: (containerId: string, axis: GridAxis) => number
  /** What `setManual(id, true, measured)` would write, without writing: nearest cells plus the unsupported children. */
  measureCells: (containerId: string, measured: MeasuredGrid) => MeasuredCells
  /** Occupied area of every in-flow child under the editor's placement model (HUD and drag insertion). */
  occupancy: (containerId: string) => Record<string, GridArea>
}

// The context exposes children per slot only by name; reorders are emitted only when every child sits in this slot.
const reorderSlot = 'children'
const startKey = { columns: 'columnStart', rows: 'rowStart' } as const
const spanKey = { columns: 'columnSpan', rows: 'rowSpan' } as const
const flowLayout: NodeLayout = { item: { position: { mode: 'flow' } } }
const lineValue = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= maxGridLine
const oneOf = <T>(list: readonly T[], value: unknown): value is T => (list as readonly unknown[]).includes(value)
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

type Component = Extract<FileNode, { type: 'component' }>
const isComponent = (node: FileNode | undefined): node is Component => node?.type === 'component'
const gridOf = (node: FileNode | undefined): GridContainer | null => isComponent(node) && node.layout?.container?.display === 'grid' && node.layout.container.grid ? node.layout.container.grid : null
const inFlow = (node: Component) => node.layout?.item.position.mode !== 'absolute'
const placementInput = (node: Component): GridPlacementInput => {
  const grid = node.layout?.item.grid ?? {}
  return { id: node.id, columnStart: grid.columnStart, rowStart: grid.rowStart, columnSpan: grid.columnSpan, rowSpan: grid.rowSpan }
}
const hasStart = (input: GridPlacementInput) => input.columnStart !== undefined || input.rowStart !== undefined
const placementOptions = (grid: GridContainer): GridPlacementOptions => ({ autoFlow: grid.autoFlow, explicitColumns: grid.columns.length, explicitRows: grid.rows.length })
const withContainerGrid = (node: Component, grid: GridContainer): NodeLayout => ({ ...node.layout!, container: { ...node.layout!.container!, grid } })
const withItemGrid = (layout: NodeLayout | undefined, grid: GridItem): NodeLayout => {
  const base = layout ?? flowLayout
  const item = { ...base.item }
  if (Object.keys(grid).length) item.grid = grid
  else delete item.grid
  return { ...base, item }
}
const setLayout = (nodeId: string, layout: NodeLayout): FileCommand => ({ type: 'node.setLayout', nodeId, layout })

/**
 * Remaps an occupied area after moving track `from` to `to`: every covered track follows the move. Returns null when
 * the covered tracks are no longer adjacent, which no automatic placement can reproduce.
 */
function remapArea(area: GridArea, axis: GridAxis, from: number, to: number): GridArea | null {
  const begin = axis === 'columns' ? area.column : area.row
  const count = axis === 'columns' ? area.columnSpan : area.rowSpan
  const tracks = Array.from({ length: count }, (_, index) => remapStartAfterTrackMove(begin + index, from, to)!).sort((left, right) => left - right)
  if (tracks.some((track, index) => track !== tracks[0]! + index)) return null
  return axis === 'columns' ? { ...area, column: tracks[0]! } : { ...area, row: tracks[0]! }
}

/** Nearest start on one axis for a measured interval, honouring the self alignment that placed it inside its area. */
function nearestStart(spans: readonly GridTrackSpan[], low: number, high: number, span: number, alignment: ItemAlignment): number | null {
  if (!spans.length || high < spans[0]!.start || low > spans.at(-1)!.end) return null
  const last = Math.max(1, spans.length - span + 1)
  let best = 1, bestScore = Number.POSITIVE_INFINITY
  for (let start = 1; start <= last; start++) {
    const areaLow = spans[start - 1]!.start, areaHigh = spans[Math.min(spans.length, start + span - 1) - 1]!.end
    const score = alignment === 'start' ? Math.abs(low - areaLow)
      : alignment === 'end' ? Math.abs(high - areaHigh)
      : alignment === 'center' ? Math.abs((low + high) / 2 - (areaLow + areaHigh) / 2)
      : Math.abs(low - areaLow) + Math.abs(high - areaHigh)
    if (score < bestScore) { best = start; bestScore = score }
  }
  return best
}

export function createGridCommands(context: LayoutCommandContext): GridCommands {
  const component = (id: string) => { const node = context.node(id); return isComponent(node) ? node : null }
  const children = (containerId: string) => context.childrenOf(containerId).map(component).filter((node): node is Component => node !== null)
  const flowChildren = (containerId: string) => children(containerId).filter(inFlow)
  const containers = (nodeIds: readonly string[]) => [...new Set(nodeIds)].map(component).filter((node): node is Component => gridOf(node ?? undefined) !== null)
  const gridChildren = (nodeIds: readonly string[]) => [...new Set(nodeIds)].map(component).filter((node): node is Component => { if (!node) return false; const parent = context.parentOf(node.id); return parent !== null && gridOf(context.node(parent)) !== null })
  const minimum = (containerId: string, axis: GridAxis) => requiredTracks(children(containerId).map(placementInput), axis)

  /** Reorders that turn the in-flow children into `order`, leaving every other sibling where it is; null when impossible. */
  const reorderCommands = (containerId: string, order: readonly string[]): FileCommand[] | null => {
    const siblings = context.childrenOf(containerId, reorderSlot)
    if (siblings.length !== context.childrenOf(containerId).length) return null
    const flow = new Set(order)
    const queue = [...order]
    const target = siblings.map(id => flow.has(id) ? queue.shift()! : id)
    const current = [...siblings]
    const commands: FileCommand[] = []
    target.forEach((id, index) => {
      if (current[index] === id) return
      commands.push({ type: 'node.reorder', nodeId: id, index })
      current.splice(current.indexOf(id), 1)
      current.splice(index, 0, id)
    })
    return commands
  }
  const orderCommands = (containerId: string, current: readonly string[], order: readonly string[] | null): FileCommand[] | null => {
    if (!order) return null
    if (same(order, current)) return []
    return reorderCommands(containerId, order)
  }

  const editContainers = (nodeIds: string[], edit: (grid: GridContainer, node: Component) => GridContainer | null) => context.executeBatch(containers(nodeIds).flatMap((node): FileCommand[] => {
    const grid = gridOf(node)!
    const next = edit(grid, node)
    return next && !same(next, grid) ? [setLayout(node.id, withContainerGrid(node, next))] : []
  }))

  const measureCells = (containerId: string, measured: MeasuredGrid): MeasuredCells => {
    const grid = gridOf(context.node(containerId))
    const result: MeasuredCells = { cells: {}, unsupported: [] }
    if (!grid) return result
    const overlay = gridOverlay({ ...measured, distribution: measured.distribution ?? { justifyContent: grid.justifyContent, alignContent: grid.alignContent } })
    for (const child of flowChildren(containerId)) {
      const rect = measured.children[child.id]
      const item = child.layout?.item.grid ?? {}
      const column = rect ? nearestStart(overlay.columns, rect.x, rect.x + rect.width, item.columnSpan ?? 1, item.justifySelf ?? grid.justifyItems ?? 'stretch') : null
      const row = rect ? nearestStart(overlay.rows, rect.y, rect.y + rect.height, item.rowSpan ?? 1, item.alignSelf ?? grid.alignItems ?? 'stretch') : null
      if (column === null || row === null) result.unsupported.push(child.id)
      else result.cells[child.id] = { column, row }
    }
    return result
  }

  return {
    setTracks: (axis, tracks, nodeIds) => {
      if (!tracks.length || tracks.length > maxGridTracks || !tracks.every(track => validateGridTrack(track))) return false
      return editContainers(nodeIds, grid => ({ ...grid, [axis]: structuredClone(tracks) }))
    },
    addTrack: (axis, nodeIds) => editContainers(nodeIds, grid => grid[axis].length >= maxGridTracks ? null : { ...grid, [axis]: [...grid[axis], fr(1)] }),
    removeTrack: (axis, index, nodeIds) => {
      const commands: FileCommand[] = []
      for (const node of containers(nodeIds)) {
        const grid = gridOf(node)!
        const count = grid[axis].length
        if (!Number.isInteger(index) || index < 1 || index > count) return false
        const remaining = count - 1
        // One container below its minimum refuses the whole selection, so a multi-selection never half-applies.
        if (remaining < Math.max(1, minimum(node.id, axis))) return false
        commands.push(setLayout(node.id, withContainerGrid(node, { ...grid, [axis]: grid[axis].filter((_, position) => position !== index - 1) })))
        for (const child of children(node.id)) {
          const current = child.layout?.item.grid
          if (!current) continue
          const repair = repairAfterTrackRemoval(placementInput(child), axis, index, remaining)
          const next: GridItem = { ...current }
          const start = repair[startKey[axis]], span = repair[spanKey[axis]] ?? 1
          if (start === undefined) delete next[startKey[axis]]
          else next[startKey[axis]] = start
          if (span !== (current[spanKey[axis]] ?? 1)) { if (span > 1) next[spanKey[axis]] = span; else delete next[spanKey[axis]] }
          if (!same(next, current)) commands.push(setLayout(child.id, withItemGrid(child.layout, next)))
        }
      }
      return context.executeBatch(commands)
    },
    moveTrack: (axis, from, to, nodeIds) => {
      const commands: FileCommand[] = []
      for (const node of containers(nodeIds)) {
        const grid = gridOf(node)!
        const count = grid[axis].length
        if (![from, to].every(value => Number.isInteger(value) && value >= 1 && value <= count) || from === to) continue
        const tracks = [...grid[axis]]
        const [moved] = tracks.splice(from - 1, 1)
        tracks.splice(to - 1, 0, moved!)
        commands.push(setLayout(node.id, withContainerGrid(node, { ...grid, [axis]: tracks })))
        const options = placementOptions(grid)
        const flow = flowChildren(node.id)
        const before = placeGridItems(flow.map(placementInput), options)
        const remapped = flow.map(child => { const input = placementInput(child); return { ...input, [startKey[axis]]: remapStartAfterTrackMove(input[startKey[axis]], from, to) } })
        for (const child of children(node.id)) {
          const current = child.layout?.item.grid
          const start = current?.[startKey[axis]]
          if (!current || start === undefined) continue
          const next = remapStartAfterTrackMove(start, from, to)
          if (next !== start) commands.push(setLayout(child.id, withItemGrid(child.layout, { ...current, [startKey[axis]]: next })))
        }
        // Children placed automatically follow their tracks too; a new sibling order keeps them there when one exists.
        const target = new Map<string, GridArea>()
        let reachable = true
        for (const input of remapped) {
          if (input.columnStart !== undefined && input.rowStart !== undefined) continue
          const area = before.get(input.id)
          const next = area ? remapArea(area, axis, from, to) : null
          if (next) target.set(input.id, next)
          else reachable = false
        }
        if (!reachable || !target.size) continue
        const reorder = orderCommands(node.id, flow.map(child => child.id), findPlacementOrder(remapped, target, options))
        if (reorder) commands.push(...reorder)
      }
      return context.executeBatch(commands)
    },
    setAutoFlow: (autoFlow, nodeIds) => oneOf(['row', 'column'] as const, autoFlow) ? editContainers(nodeIds, grid => ({ ...grid, autoFlow })) : false,
    setAlignment: (alignment, nodeIds) => {
      const keys = ['justifyItems', 'alignItems', 'justifyContent', 'alignContent'] as const
      for (const key of keys) {
        const value = alignment[key]
        if (value === undefined || value === null) continue
        if (!oneOf(key === 'justifyItems' || key === 'alignItems' ? itemAlignments : contentDistributions, value)) return false
      }
      return editContainers(nodeIds, grid => {
        const next: Record<string, unknown> = { ...grid }
        for (const key of keys) {
          if (!(key in alignment) || alignment[key] === undefined) continue
          if (alignment[key] === null) delete next[key]
          else next[key] = alignment[key]
        }
        return next as GridContainer
      })
    },
    setPlacement: (placement, nodeIds) => {
      const lines = ['columnStart', 'rowStart', 'columnSpan', 'rowSpan'] as const
      const selves = ['justifySelf', 'alignSelf'] as const
      for (const key of lines) { const value = placement[key]; if (value !== undefined && value !== null && !lineValue(value)) return false }
      for (const key of selves) { const value = placement[key]; if (value !== undefined && value !== null && !oneOf(itemAlignments, value)) return false }
      return context.executeBatch(gridChildren(nodeIds).flatMap((child): FileCommand[] => {
        const current = child.layout?.item.grid ?? {}
        const next: Record<string, unknown> = { ...current }
        for (const key of [...lines, ...selves]) {
          const value = placement[key]
          if (value === undefined) continue
          if (value === null) delete next[key]
          else next[key] = value
        }
        return same(next, current) ? [] : [setLayout(child.id, withItemGrid(child.layout, next as GridItem))]
      }))
    },
    isManual: containerId => gridOf(context.node(containerId)) !== null && flowChildren(containerId).some(child => hasStart(placementInput(child))),
    setManual: (containerId, manual, measured) => {
      const grid = gridOf(context.node(containerId))
      if (!grid) return false
      const flow = flowChildren(containerId)
      if (manual) {
        if (!measured) return false
        const { cells } = measureCells(containerId, measured)
        return context.executeBatch(flow.flatMap((child): FileCommand[] => {
          const cell = cells[child.id]
          if (!cell) return []
          const current = child.layout?.item.grid ?? {}
          const next: GridItem = { ...current, columnStart: cell.column, rowStart: cell.row }
          return same(next, current) ? [] : [setLayout(child.id, withItemGrid(child.layout, next))]
        }))
      }
      const inputs = flow.map(placementInput)
      if (!inputs.some(hasStart)) return false
      // Same guard as `isAutoPlacementEquivalent`: a span along the flow axis never converts back to automatic placement.
      if (inputs.some(input => (grid.autoFlow === 'row' ? input.rowSpan ?? 1 : input.columnSpan ?? 1) > 1)) return false
      const options = placementOptions(grid)
      const target = placeGridItems(inputs, options)
      const cleared = inputs.map(input => ({ id: input.id, columnSpan: input.columnSpan, rowSpan: input.rowSpan }))
      const reorder = orderCommands(containerId, inputs.map(input => input.id), findPlacementOrder(cleared, target, options))
      if (!reorder) return false
      const clears = flow.flatMap((child): FileCommand[] => {
        const current = child.layout?.item.grid
        if (!current || (current.columnStart === undefined && current.rowStart === undefined)) return []
        const next: GridItem = { ...current }
        delete next.columnStart; delete next.rowStart
        return [setLayout(child.id, withItemGrid(child.layout, next))]
      })
      return context.executeBatch([...clears, ...reorder])
    },
    moveToCell: (childId, cell) => {
      if (!lineValue(cell.column) || !lineValue(cell.row)) return false
      const [child] = gridChildren([childId])
      if (!child) return false
      const current = child.layout?.item.grid ?? {}
      const next: GridItem = { ...current, columnStart: cell.column, rowStart: cell.row }
      return same(next, current) ? false : context.execute(setLayout(child.id, withItemGrid(child.layout, next)))
    },
    minimumTracks: (containerId, axis) => gridOf(context.node(containerId)) ? minimum(containerId, axis) : 1,
    measureCells,
    occupancy: containerId => {
      const grid = gridOf(context.node(containerId))
      return grid ? Object.fromEntries(placeGridItems(flowChildren(containerId).map(placementInput), placementOptions(grid))) : {}
    },
  }
}
