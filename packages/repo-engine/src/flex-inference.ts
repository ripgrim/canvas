/**
 * Freeform-to-Flex inference from measured child rectangles (the observed Wonder `flex-params-calculator` rules):
 * direction from center spread, lines by 50% cross-axis overlap, gaps voted in 4 px buckets, alignment by least
 * squared error, padding from the smaller opposing inset, and a reproducibility verdict that rejects wrapping.
 */
import type { CrossAlignment, FlexDirection, MainDistribution } from './layout.js'

export type Rect = { x: number; y: number; width: number; height: number }
export type FlexInferenceInput = { container: Rect; children: readonly ({ id: string } & Rect)[] }
export type FlexInference = {
  direction: FlexDirection
  wrap: 'nowrap'
  gap: number
  justify: MainDistribution
  align: CrossAlignment
  padding: { x: number; y: number }
  /** Child ids in visual order (line by line, main-axis start ascending). */
  order: string[]
  lines: number
  reproducible: boolean
  reasons: string[]
}
const bucket = 4
const tolerance = 2
const round4 = (value: number) => Math.round(value / bucket) * bucket

export function inferFlexLayout(input: FlexInferenceInput): FlexInference | null {
  const children = input.children.filter(child => child.width > 0 && child.height > 0)
  if (!children.length) return null
  const centersX = children.map(child => child.x + child.width / 2), centersY = children.map(child => child.y + child.height / 2)
  const spreadX = Math.max(...centersX) - Math.min(...centersX), spreadY = Math.max(...centersY) - Math.min(...centersY)
  const direction: FlexDirection = spreadX >= spreadY ? 'row' : 'column'
  const row = direction === 'row'
  const main = (rect: Rect) => row ? { start: rect.x, size: rect.width } : { start: rect.y, size: rect.height }
  const cross = (rect: Rect) => row ? { start: rect.y, size: rect.height } : { start: rect.x, size: rect.width }

  // Lines: sorted by cross start, an item joins the current line when it overlaps the line's first item by at least
  // half of the smaller cross size.
  const byCross = [...children].sort((left, right) => cross(left).start - cross(right).start || main(left).start - main(right).start)
  const lines: (typeof children)[] = []
  for (const child of byCross) {
    const line = lines[lines.length - 1]
    const head = line?.[0]
    if (head) {
      const a = cross(head), b = cross(child)
      const overlap = Math.min(a.start + a.size, b.start + b.size) - Math.max(a.start, b.start)
      if (overlap >= 0.5 * Math.min(a.size, b.size)) { line.push(child); continue }
    }
    lines.push([child])
  }
  for (const line of lines) line.sort((left, right) => main(left).start - main(right).start)
  const order = lines.flatMap(line => line.map(child => child.id))
  const reasons: string[] = []
  if (lines.length > 1) reasons.push('Children wrap onto more than one line')

  // Gap: raw adjacent gaps along the main axis; under 2 px is zero; otherwise the most common 4 px bucket wins and
  // the raw values inside that bucket are averaged.
  const rawGaps: number[] = []
  for (const line of lines) for (let index = 1; index < line.length; index++) { const previous = main(line[index - 1]!), current = main(line[index]!); rawGaps.push(current.start - (previous.start + previous.size)) }
  let gap = 0
  if (rawGaps.length) {
    const votes = new Map<number, number[]>()
    for (const raw of rawGaps) { const key = raw < tolerance ? 0 : Math.round(raw / bucket); (votes.get(key) ?? votes.set(key, []).get(key)!).push(raw) }
    const winner = [...votes.entries()].sort((left, right) => right[1].length - left[1].length || left[0] - right[0])[0]!
    gap = winner[0] === 0 ? 0 : Math.round(winner[1].reduce((sum, raw) => sum + raw, 0) / winner[1].length)
    if (rawGaps.some(raw => Math.abs(Math.max(0, raw) - gap) > tolerance)) reasons.push('Adjacent gaps differ by more than 2 px')
  }

  // Padding: the smaller opposing inset per axis, bucketed to 4 px, never negative.
  const minX = Math.min(...children.map(child => child.x)), maxX = Math.max(...children.map(child => child.x + child.width))
  const minY = Math.min(...children.map(child => child.y)), maxY = Math.max(...children.map(child => child.y + child.height))
  const insetX = Math.max(0, Math.min(minX - input.container.x, input.container.x + input.container.width - maxX))
  const insetY = Math.max(0, Math.min(minY - input.container.y, input.container.y + input.container.height - maxY))
  const padding = { x: round4(insetX), y: round4(insetY) }

  // Main alignment: compare the content extent against start/center/end positions inside the padded box.
  const innerStart = row ? input.container.x + padding.x : input.container.y + padding.y
  const innerSize = (row ? input.container.width - 2 * padding.x : input.container.height - 2 * padding.y)
  const contentStart = row ? minX : minY, contentEnd = row ? maxX : maxY
  const contentSize = contentEnd - contentStart
  const candidates: [MainDistribution, number][] = [['start', innerStart], ['center', innerStart + (innerSize - contentSize) / 2], ['end', innerStart + innerSize - contentSize]]
  const scored = candidates.map(([name, expected]) => [name, (contentStart - expected) ** 2] as const).sort((left, right) => left[1] - right[1] || candidates.findIndex(c => c[0] === left[0]) - candidates.findIndex(c => c[0] === right[0]))
  const justify = scored[0]![0]

  // Cross alignment: stretch when every item fills the inner cross size; otherwise least normalized error of start/center/end.
  const crossInnerStart = row ? input.container.y + padding.y : input.container.x + padding.x
  const crossInnerSize = row ? input.container.height - 2 * padding.y : input.container.width - 2 * padding.x
  const stretched = children.every(child => Math.abs(cross(child).size - crossInnerSize) <= tolerance && Math.abs(cross(child).start - crossInnerStart) <= tolerance)
  let align: CrossAlignment = 'start'
  let crossError = 0
  if (stretched) align = 'stretch'
  else {
    const options: [CrossAlignment, (child: Rect) => number][] = [['start', () => crossInnerStart], ['center', child => crossInnerStart + (crossInnerSize - cross(child).size) / 2], ['end', child => crossInnerStart + crossInnerSize - cross(child).size]]
    const errors = options.map(([name, expected]) => [name, children.reduce((sum, child) => sum + Math.abs(cross(child).start - expected(child)), 0) / children.length] as const)
    const best = errors.sort((left, right) => left[1] - right[1] || options.findIndex(o => o[0] === left[0]) - options.findIndex(o => o[0] === right[0]))[0]!
    align = best[0]; crossError = best[1]
  }
  if (crossError > tolerance) reasons.push('Cross-axis alignment differs by more than 2 px')

  return { direction, wrap: 'nowrap', gap, justify, align, padding, order, lines: lines.length, reproducible: reasons.length === 0, reasons }
}
