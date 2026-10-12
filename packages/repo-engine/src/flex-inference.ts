import type { PositionMode } from './layout.js'

export type Point = { x: number; y: number }
export type Size = { width: number; height: number }
export type Rect = Point & Size
export type FlexAnalysisKind = 'direct-add' | 'wrap'
export type FlexAnalysisChild = {
  id: string
  /** Measured world-axis-aligned border box. Used only for direction and cross alignment. */
  worldAabb: Rect
  /** Authored coordinates in the parent's local coordinate system. Used only for stable spatial ordering. */
  authoredPosition: Point
  /** Authored dimensions before rotation. Used for gaps and synthetic layout. */
  authoredSize: Size
  /** Border-box center transformed into the parent's local padding-box coordinate system. */
  parentLocalCenter: Point
  sourcePosition: PositionMode
}
export type FlexInferenceInput = {
  /** Authored container size. Used only for the empty-container direction default. */
  containerSize: Size
  /** Children in tree order. Equal authored main-axis positions retain this order. */
  children: readonly FlexAnalysisChild[]
  /** Rounded only by the analyzer; the caller derives this from the selection union in the parent padding box. */
  directAddLeadingInset: Point
  kind: FlexAnalysisKind
  isRoot: boolean
}
export type PaperFlexDirection = 'row' | 'column'
export type PaperCrossAlignment = 'start' | 'center' | 'end'
export type FlexChildPlan = FlexAnalysisChild & {
  treeIndex: number
  synthetic: Rect
  position: 'flow' | 'absolute'
}
export type FlexInference = {
  direction: PaperFlexDirection
  wrap: 'nowrap'
  gap: number
  justify: 'start'
  align: PaperCrossAlignment
  padding: Point
  order: string[]
  worldBounds: Rect | null
  synthetic: {
    container: Rect
    children: FlexChildPlan[]
  }
}

const round = (value: number) => Math.round(value)
const edge = (rect: Rect, axis: keyof Point) => rect[axis] + (axis === 'x' ? rect.width : rect.height)
const center = (rect: Rect, axis: keyof Point) => rect[axis] + (axis === 'x' ? rect.width : rect.height) / 2

function union(rects: readonly Rect[]): Rect {
  const left = Math.min(...rects.map(rect => rect.x))
  const top = Math.min(...rects.map(rect => rect.y))
  const right = Math.max(...rects.map(rect => rect.x + rect.width))
  const bottom = Math.max(...rects.map(rect => rect.y + rect.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function range(values: readonly number[]): number {
  return Math.max(...values) - Math.min(...values)
}

function directionOf(children: readonly FlexAnalysisChild[], bounds: Rect | null, containerSize: Size): PaperFlexDirection {
  if (children.length === 0) return containerSize.width > containerSize.height ? 'row' : 'column'
  if (children.length === 1) return children[0]!.authoredSize.width > children[0]!.authoredSize.height ? 'column' : 'row'
  const world = children.map(child => child.worldAabb)
  const xSpread = range(world.map(rect => center(rect, 'x')))
  const ySpread = range(world.map(rect => center(rect, 'y')))
  const normalizedX = bounds!.width > 0 ? xSpread / bounds!.width : 0
  const normalizedY = bounds!.height > 0 ? ySpread / bounds!.height : 0
  return normalizedX < normalizedY ? 'column' : 'row'
}

function alignmentOf(children: readonly FlexAnalysisChild[], direction: PaperFlexDirection): PaperCrossAlignment {
  if (children.length === 0) return direction === 'row' ? 'center' : 'start'
  if (children.length === 1) return children[0]!.authoredSize.width > children[0]!.authoredSize.height ? 'start' : 'center'
  const axis = direction === 'row' ? 'y' : 'x'
  const world = children.map(child => child.worldAabb)
  const candidates: readonly [PaperCrossAlignment, number][] = [
    ['start', range(world.map(rect => rect[axis]))],
    ['end', range(world.map(rect => edge(rect, axis)))],
    ['center', range(world.map(rect => center(rect, axis)))],
  ]
  return candidates.reduce((best, candidate) => candidate[1] < best[1] ? candidate : best)[0]
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function childGap(previous: FlexAnalysisChild, current: FlexAnalysisChild, axis: keyof Point): number {
  const size = axis === 'x' ? 'width' : 'height'
  const previousEnd = previous.parentLocalCenter[axis] + previous.authoredSize[size] / 2
  const currentStart = current.parentLocalCenter[axis] - current.authoredSize[size] / 2
  return currentStart - previousEnd
}

function syntheticLayout(
  ordered: readonly { child: FlexAnalysisChild; treeIndex: number }[],
  direction: PaperFlexDirection,
  align: PaperCrossAlignment,
  gap: number,
  padding: Point,
  kind: FlexAnalysisKind,
): FlexInference['synthetic'] {
  const row = direction === 'row'
  const mainPadding = row ? padding.x : padding.y
  const crossPadding = row ? padding.y : padding.x
  const mainSize = ordered.reduce((sum, entry) => sum + (row ? entry.child.authoredSize.width : entry.child.authoredSize.height), 0)
    + gap * Math.max(0, ordered.length - 1)
    + mainPadding * 2
  const largestCross = ordered.length === 0
    ? 0
    : Math.max(...ordered.map(entry => row ? entry.child.authoredSize.height : entry.child.authoredSize.width))
  const crossSize = largestCross + crossPadding * 2
  const roundedMainSize = round(mainSize)
  const roundedCrossSize = round(crossSize)
  let cursor = mainPadding
  const children = ordered.map(({ child, treeIndex }) => {
    const childMain = row ? child.authoredSize.width : child.authoredSize.height
    const childCross = row ? child.authoredSize.height : child.authoredSize.width
    const cross = align === 'start'
      ? crossPadding
      : align === 'end'
        ? roundedCrossSize - crossPadding - childCross
        : (roundedCrossSize - childCross) / 2
    const synthetic = row
      ? { x: round(cursor), y: round(cross), width: round(child.authoredSize.width), height: round(child.authoredSize.height) }
      : { x: round(cross), y: round(cursor), width: round(child.authoredSize.width), height: round(child.authoredSize.height) }
    cursor += childMain + gap
    return {
      ...child,
      treeIndex,
      synthetic,
      position: kind === 'wrap' ? 'flow' as const : child.sourcePosition === 'absolute' ? 'absolute' as const : 'flow' as const,
    }
  })
  return {
    container: row
      ? { x: 0, y: 0, width: roundedMainSize, height: roundedCrossSize }
      : { x: 0, y: 0, width: roundedCrossSize, height: roundedMainSize },
    children,
  }
}

/** Pure Paper Add/Wrap analysis over distinct measured, authored, and parent-local geometry sources. */
export function inferFlexLayout(input: FlexInferenceInput): FlexInference {
  const worldBounds = input.children.length > 0 ? union(input.children.map(child => child.worldAabb)) : null
  const direction = directionOf(input.children, worldBounds, input.containerSize)
  const align = alignmentOf(input.children, direction)
  const padding = input.children.length === 0
    ? input.isRoot || input.kind === 'wrap' ? { x: 0, y: 0 } : { x: 16, y: 16 }
    : input.isRoot || input.kind === 'wrap'
      ? { x: 0, y: 0 }
      : {
          x: Math.max(0, round(input.directAddLeadingInset.x)),
          y: Math.max(0, round(input.directAddLeadingInset.y)),
        }
  const axis = direction === 'row' ? 'x' : 'y'
  const ordered = input.children
    .map((child, treeIndex) => ({ child, treeIndex }))
    .sort((left, right) => left.child.authoredPosition[axis] - right.child.authoredPosition[axis] || left.treeIndex - right.treeIndex)
  const adjacentGaps = ordered.slice(1).map((entry, index) => childGap(ordered[index]!.child, entry.child, axis))
  const gap = input.children.length === 0
    ? 16
    : input.children.length === 1
      ? direction === 'row' ? padding.x : padding.y
      : Math.max(0, round(median(adjacentGaps)))
  const synthetic = syntheticLayout(ordered, direction, align, gap, padding, input.kind)
  return {
    direction,
    wrap: 'nowrap',
    gap,
    justify: 'start',
    align,
    padding,
    order: ordered.map(entry => entry.child.id),
    worldBounds,
    synthetic,
  }
}
