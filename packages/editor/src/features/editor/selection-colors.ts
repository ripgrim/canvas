import { borderStrokes } from '@canvas/repo-engine/appearance'
import type { Appearance, Borders, ColorValue, GradientStop, Paint, Stroke } from '@canvas/repo-engine/appearance'
import { colorToHex } from '@canvas/repo-engine/color'
import { childrenOf, resolveColorValue } from '@canvas/repo-engine/file-document'
import type { FileDocument, SourcePalette } from '@canvas/repo-engine/file-document'

export type SelectionColorGroup = {
  key: string
  value: ColorValue
  resolved: string
  name: string
  /** Nodes in the current selection subtree whose colors are edited by this row. */
  nodeIds: string[]
  /** Every node in the file that uses this exact literal or token identity. */
  usageNodeIds: string[]
  occurrences: number
}

const keyOf = (value: ColorValue) => value.kind === 'token' ? `token:${value.tokenId}` : `literal:${colorToHex(value.color)}`

/** Active editable colors only. Cached paint variants stay untouched until their type becomes active. */
function activeColors(appearance: Appearance): ColorValue[] {
  const colors: ColorValue[] = []
  for (const paint of appearance.fills ?? []) {
    if (paint.type === 'solid') colors.push(paint.color)
    else if (paint.type === 'gradient') colors.push(...paint.stops.map(stop => stop.color))
  }
  if (appearance.outline) colors.push(appearance.outline.color)
  colors.push(...borderStrokes(appearance.borders).map(stroke => stroke.color))
  return colors
}

/** Selected nodes plus descendants, capped so an imported tree cannot stall the inspector. */
export function selectionColorGroups(file: FileDocument, selection: readonly string[], paletteFor: (nodeId: string) => SourcePalette, nodeLimit = 1000, groupLimit = 100): SelectionColorGroup[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const selected of selection) {
    const pending = [selected]
    while (pending.length && ids.length < nodeLimit) {
      const id = pending.shift()!
      if (seen.has(id)) continue
      seen.add(id)
      ids.push(id)
      pending.push(...childrenOf(file, id))
    }
    if (ids.length >= nodeLimit) break
  }
  const groups = new Map<string, { value: ColorValue; nodes: Set<string>; occurrences: number }>()
  for (const id of ids) {
    const node = file.nodes[id]
    if (!node || node.type === 'root' || !node.appearance) continue
    for (const value of activeColors(node.appearance)) {
      const key = keyOf(value)
      let group = groups.get(key)
      if (!group) {
        if (groups.size >= groupLimit) continue
        group = { value, nodes: new Set(), occurrences: 0 }
        groups.set(key, group)
      }
      group.nodes.add(id)
      group.occurrences += 1
    }
  }
  const tokenOrder = new Map(Object.values(file.theme.tokens).sort((left, right) => left.orderKey.localeCompare(right.orderKey)).map((token, index) => [token.id, index]))
  const usage = new Map<string, Set<string>>()
  for (const node of Object.values(file.nodes)) {
    if (node.type === 'root' || !node.appearance) continue
    for (const value of activeColors(node.appearance)) {
      const key = keyOf(value)
      if (!groups.has(key)) continue
      const matches = usage.get(key) ?? new Set<string>()
      matches.add(node.id)
      usage.set(key, matches)
    }
  }
  return [...groups].map(([key, group]) => {
    const nodeIds = [...group.nodes]
    const resolved = resolveColorValue(file.theme, group.value, paletteFor(nodeIds[0] ?? ''))
    const name = group.value.kind === 'token' ? file.theme.tokens[group.value.tokenId]?.name ?? group.value.tokenId : colorToHex(group.value.color).replace('#', '').toUpperCase()
    return { key, value: group.value, resolved: colorToHex(resolved ?? { kind: 'hex', hex: '#000000' }), name, nodeIds, usageNodeIds: [...(usage.get(key) ?? [])], occurrences: group.occurrences }
  }).sort((left, right) => right.usageNodeIds.length - left.usageNodeIds.length
    || (left.value.kind === 'token' ? tokenOrder.get(left.value.tokenId) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER) - (right.value.kind === 'token' ? tokenOrder.get(right.value.tokenId) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER)
    || left.key.localeCompare(right.key))
}

const replaceStops = (stops: GradientStop[], key: string, next: ColorValue) => stops.map(stop => keyOf(stop.color) === key ? { ...stop, color: next } : stop)
const replacePaint = (paint: Paint, key: string, next: ColorValue): Paint => paint.type === 'solid'
  ? keyOf(paint.color) === key ? { ...paint, color: next } : paint
  : paint.type === 'gradient' ? { ...paint, stops: replaceStops(paint.stops, key, next) } : paint
const replaceStroke = <T extends Stroke>(stroke: T, key: string, next: ColorValue): T => keyOf(stroke.color) === key ? { ...stroke, color: next } : stroke

export function replaceSelectionColor(appearance: Appearance, key: string, next: ColorValue): Appearance {
  let borders: Borders | undefined
  if (appearance.borders) borders = 'all' in appearance.borders && appearance.borders.all
    ? { all: replaceStroke(appearance.borders.all, key, next) }
    : Object.fromEntries(Object.entries(appearance.borders).map(([side, stroke]) => [side, replaceStroke(stroke!, key, next)])) as Borders
  return {
    ...appearance,
    ...(appearance.fills ? { fills: appearance.fills.map(paint => replacePaint(paint, key, next)) } : {}),
    ...(appearance.outline ? { outline: replaceStroke(appearance.outline, key, next) } : {}),
    ...(borders ? { borders } : {}),
  }
}
