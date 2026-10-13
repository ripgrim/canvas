import { classifySizing, isValidLayout } from './layout.js'
import type { AxisSize, DisplayMode, FlexDirection, NodeLayout, NodePosition } from './layout.js'
import type { PrimitiveStyles } from './file-document.js'
import { textStyleMatchesSizing, validateTextAxisSizing, validateTextSizing, validateTextStyle } from './text.js'
import type { TextSizing, TextStyle } from './text.js'

export type PaperAxis = 'width' | 'height'
export type PaperSizingFamily = 'freeform' | 'flow'
export type PaperAxisIntent = 'fixed' | 'fit' | 'fill' | 'relative' | 'constrained' | 'auto' | 'inline-text'
export type PaperSizingKind = 'component' | 'primitive' | 'text'
export type PaperMeasuredSize = { width: number; height: number }
export type PaperAxisCapabilities = { fit: boolean; fill: boolean; relative: boolean; constrained: boolean }
export type PaperSizingCapabilities = { width: PaperAxisCapabilities; height: PaperAxisCapabilities }
export type PaperSizingParent = { display: DisplayMode; flexDirection?: FlexDirection }

export type PaperAxisSnapshot = {
  intent: PaperAxisIntent
  measured: number
  stored?: AxisSize
  fixedPx?: number
  relativeValue?: number
}

type PaperSizingSnapshotBase = {
  nodeId: string
  kind: PaperSizingKind
  fromFamily: PaperSizingFamily
  measured: PaperMeasuredSize
  sourceLayout: NodeLayout | null
  sourcePosition: NodePosition
  axes: { width: PaperAxisSnapshot; height: PaperAxisSnapshot }
}

export type PaperSizingSnapshot = PaperSizingSnapshotBase & {
  primitiveSize?: PaperMeasuredSize
  textProperties?: { textStyle: TextStyle; textSizing: TextSizing }
  text?: { editable: boolean; multiline: boolean }
}

export type PaperPrimitiveSizingInput = {
  nodeId: string
  kind: 'primitive'
  layout: NodeLayout | null
  styles: Pick<PrimitiveStyles, 'width' | 'height'>
  measured: PaperMeasuredSize
}
export type PaperComponentSizingInput = {
  nodeId: string
  kind: 'component'
  layout: NodeLayout | null
  measured: PaperMeasuredSize
}
export type PaperTextSizingInput = {
  nodeId: string
  kind: 'text'
  layout: NodeLayout | null
  styles: Pick<PrimitiveStyles, 'width' | 'height'>
  textStyle: TextStyle
  textSizing: TextSizing
  measured: PaperMeasuredSize
  resolvedLineHeight: number
  editable: boolean
}
export type PaperSizingSnapshotInput = PaperPrimitiveSizingInput | PaperComponentSizingInput | PaperTextSizingInput

export type PaperAxisDecision = {
  intent: Exclude<PaperAxisIntent, 'inline-text'>
  fixedPx?: number
  stored?: AxisSize
  relativeValue?: number
}

export type PaperSizingTarget = {
  nodeId: string
  layout: NodeLayout
  styles?: PaperMeasuredSize
  textProperties?: { textStyle: TextStyle; textSizing: TextSizing }
}

export type PaperSizingTransition = {
  operation: 'add' | 'wrap' | 'remove'
  snapshot: PaperSizingSnapshot
  targetPosition: NodePosition
  targetParent: PaperSizingParent
  capabilities: PaperSizingCapabilities
  overrides?: Partial<Record<PaperAxis, PaperAxisDecision>>
}

export type PaperAddSizingPlan = {
  parentAxes: { width: PaperAxisDecision; height: PaperAxisDecision }
  childAxes: { nodeId: string; axes: Partial<Record<PaperAxis, PaperAxisDecision>> }[]
}

export type PaperAddSizingInput = {
  parent: PaperSizingSnapshot
  direction: 'row' | 'column'
  inferred: PaperMeasuredSize
  parentIsFlexChild: boolean
  parentCapabilities: PaperSizingCapabilities
  children: readonly { snapshot: PaperSizingSnapshot; capabilities: PaperSizingCapabilities }[]
}

const clone = <T>(value: T): T => structuredClone(value)
const positive = (value: number): boolean => Number.isFinite(value) && value > 0
const fail = (message: string): never => { throw new Error(message) }
const familyOf = (position: NodePosition): PaperSizingFamily => position.mode === 'flow' ? 'flow' : 'freeform'
const insetPair = (position: NodePosition, axis: PaperAxis): boolean => axis === 'width'
  ? position.mode === 'absolute' && position.left !== undefined && position.right !== undefined
  : position.mode === 'absolute' && position.top !== undefined && position.bottom !== undefined

function checkedLayout(layout: NodeLayout | null): NodeLayout | null {
  if (layout !== null && !isValidLayout(layout)) fail('Paper sizing requires a valid source layout')
  return layout === null ? null : clone(layout)
}

function checkedMeasured(measured: PaperMeasuredSize): PaperMeasuredSize {
  if (!positive(measured.width) || !positive(measured.height)) fail('Paper sizing requires positive finite measurements')
  return { width: measured.width, height: measured.height }
}

function checkedPrimitiveSize(size: PaperMeasuredSize): PaperMeasuredSize {
  if (!positive(size.width) || !positive(size.height)) fail('Paper sizing requires positive finite stored dimensions')
  return { width: size.width, height: size.height }
}

function checkedCapabilities(capabilities: PaperSizingCapabilities): void {
  for (const axis of ['width', 'height'] as const) for (const key of ['fit', 'fill', 'relative', 'constrained'] as const) {
    if (typeof capabilities[axis][key] !== 'boolean') fail('Paper sizing capabilities must be explicit booleans')
  }
}

function checkedParent(parent: PaperSizingParent): void {
  if (parent.display === 'flex' && !parent.flexDirection) fail('Paper sizing requires the target Flex direction')
  if (parent.display !== 'flex' && parent.flexDirection !== undefined) fail('Only a Flex target can provide a Flex direction')
}

function axisIntent(axis: PaperAxis, kind: PaperSizingKind, position: NodePosition, stored: AxisSize | undefined, fixedPx: number | undefined, textSizing?: TextSizing): PaperAxisSnapshot {
  const measured = 0
  if (kind === 'text') {
    const sizing = textSizing![axis]
    if (sizing.mode === 'fit') return { intent: axis === 'width' ? 'inline-text' : 'fit', measured }
    if (sizing.mode === 'relative') return { intent: 'relative', measured, relativeValue: sizing.value }
    return { intent: sizing.mode, measured, ...(sizing.mode === 'fixed' && fixedPx !== undefined ? { fixedPx } : {}) }
  }
  if (insetPair(position, axis) || stored?.min !== undefined || stored?.max !== undefined) return { intent: 'constrained', measured, ...(stored ? { stored: clone(stored) } : {}), ...(fixedPx !== undefined ? { fixedPx } : {}) }
  if (!stored) return kind === 'primitive' ? { intent: 'fixed', measured, ...(fixedPx !== undefined ? { fixedPx } : {}) } : { intent: 'auto', measured }
  const mode = classifySizing(stored.value)
  switch (mode) {
    case 'fixed': {
      const value = stored.value.kind === 'px' ? stored.value.value : fixedPx
      return { intent: 'fixed', measured, stored: clone(stored), ...(value !== undefined ? { fixedPx: value } : {}) }
    }
    case 'hug': return { intent: 'fit', measured, stored: clone(stored) }
    case 'fill': return { intent: 'fill', measured, stored: clone(stored) }
    case 'relative': return { intent: 'relative', measured, stored: clone(stored), ...(stored.value.kind === 'percent' ? { relativeValue: stored.value.value } : {}) }
    case 'auto': return { intent: 'auto', measured, stored: clone(stored) }
    case 'calculate': return fail('Paper sizing cannot reconcile calculated lengths')
  }
}

export function snapshotPaperSizing(input: PaperSizingSnapshotInput): PaperSizingSnapshot {
  if (!input.nodeId) fail('Paper sizing requires a node identity')
  const measured = checkedMeasured(input.measured)
  const layout = checkedLayout(input.layout)
  const position: NodePosition = clone(layout?.item.position ?? { mode: input.kind === 'component' ? 'flow' : 'freeform' })
  if (input.kind !== 'component') checkedPrimitiveSize(input.styles)
  if (input.kind === 'text' && !positive(input.resolvedLineHeight)) fail('Paper text sizing requires a positive finite resolved line height')
  if (input.kind === 'text' && (!validateTextStyle(input.textStyle) || !validateTextSizing(input.textSizing) || !textStyleMatchesSizing(input.textStyle, input.textSizing))) fail('Paper sizing requires valid text properties')
  const fixed = input.kind === 'component' ? undefined : input.styles
  const width = axisIntent('width', input.kind, position, layout?.item.width, fixed?.width, input.kind === 'text' ? input.textSizing : undefined)
  const height = axisIntent('height', input.kind, position, layout?.item.height, fixed?.height, input.kind === 'text' ? input.textSizing : undefined)
  width.measured = measured.width
  height.measured = measured.height
  const base: PaperSizingSnapshot = {
    nodeId: input.nodeId,
    kind: input.kind,
    fromFamily: familyOf(position),
    measured,
    sourceLayout: layout,
    sourcePosition: position,
    axes: { width, height },
    ...(input.kind === 'component' ? {} : { primitiveSize: { width: input.styles.width, height: input.styles.height } }),
  }
  if (input.kind === 'text') {
    base.textProperties = { textStyle: clone(input.textStyle), textSizing: clone(input.textSizing) }
    base.text = { editable: input.editable, multiline: measured.height / input.resolvedLineHeight > 1.5 }
  }
  return base
}

const capability = (capabilities: PaperAxisCapabilities, intent: PaperAxisIntent): boolean => {
  if (intent === 'fixed' || intent === 'auto') return true
  if (intent === 'fit' || intent === 'inline-text') return capabilities.fit
  return capabilities[intent]
}

const fixedDecision = (value: number): PaperAxisDecision => positive(value) ? { intent: 'fixed', fixedPx: value } : fail('Paper sizing requires a positive finite fixed size')
const fitDecision = (minimum?: number): PaperAxisDecision => {
  const stored: AxisSize = { value: { kind: 'intrinsic', value: 'fit-content' } }
  if (minimum !== undefined && positive(minimum)) stored.min = { kind: 'px', value: minimum }
  return { intent: 'fit', stored }
}
const fillDecision = (): PaperAxisDecision => ({ intent: 'fill', stored: { value: { kind: 'percent', value: 100 } } })

function preservedDecision(axis: PaperAxisSnapshot): PaperAxisDecision {
  if (axis.intent === 'inline-text') return fitDecision()
  return {
    intent: axis.intent,
    ...(axis.fixedPx !== undefined ? { fixedPx: axis.fixedPx } : {}),
    ...(axis.stored ? { stored: clone(axis.stored) } : {}),
    ...(axis.relativeValue !== undefined ? { relativeValue: axis.relativeValue } : {}),
  }
}

function checkedRelative(value: number | undefined, kind: PaperSizingKind): number {
  if (kind === 'text') {
    if (!validateTextAxisSizing({ mode: 'relative', value })) fail('Relative text sizing is outside the authoritative text domain')
    return value as number
  }
  // Layout percentages use validateAxisSize's zero-inclusive domain, but exact 100 is reserved for Fill.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 100) fail('Relative layout sizing requires a percentage from 0 up to but excluding 100')
  return value as number
}

function checkedStoredAxis(stored: AxisSize | undefined): AxisSize | undefined {
  if (!stored) return undefined
  if (!isValidLayout({ item: { position: { mode: 'flow' }, width: stored } })) fail('Paper sizing requires a valid stored axis')
  return stored
}

function checkedDecision(decision: PaperAxisDecision, kind: PaperSizingKind): PaperAxisDecision {
  if (decision.intent === 'fixed') return fixedDecision(decision.fixedPx ?? fail('Fixed sizing requires its pixel value'))
  if (decision.intent === 'relative') {
    const value = decision.relativeValue ?? (decision.stored?.value.kind === 'percent' ? decision.stored.value.value : undefined)
    checkedRelative(value, kind)
  }
  if (decision.stored) checkedStoredAxis(decision.stored)
  if (decision.intent === 'constrained' && !decision.stored) fail('Constrained sizing requires a stored axis')
  return clone(decision)
}

function checkedSnapshot(snapshot: PaperSizingSnapshot): void {
  if (!snapshot.nodeId || !['component', 'primitive', 'text'].includes(snapshot.kind)) fail('Paper sizing requires a valid snapshot identity')
  checkedMeasured(snapshot.measured)
  const sourceLayout = checkedLayout(snapshot.sourceLayout)
  const defaultPosition: NodePosition = { mode: snapshot.kind === 'component' ? 'flow' : 'freeform' }
  const sourcePosition = sourceLayout?.item.position ?? defaultPosition
  if (!same(sourcePosition, snapshot.sourcePosition) || snapshot.fromFamily !== familyOf(sourcePosition)) fail('Paper sizing snapshot family does not match its source layout')
  if (snapshot.kind === 'component') {
    if (snapshot.primitiveSize || snapshot.textProperties || snapshot.text) fail('Component sizing snapshots cannot carry primitive or text authority')
  } else {
    if (!snapshot.primitiveSize) fail('Primitive sizing snapshots require stored dimensions')
    checkedPrimitiveSize(snapshot.primitiveSize as PaperMeasuredSize)
  }
  if (snapshot.kind === 'text') {
    if (!snapshot.textProperties || !snapshot.text || typeof snapshot.text.editable !== 'boolean' || typeof snapshot.text.multiline !== 'boolean') fail('Text sizing snapshots require complete text authority')
    const { textStyle, textSizing } = snapshot.textProperties as { textStyle: TextStyle; textSizing: TextSizing }
    if (!validateTextStyle(textStyle) || !validateTextSizing(textSizing) || !textStyleMatchesSizing(textStyle, textSizing)) fail('Paper sizing requires valid text properties')
  } else if (snapshot.textProperties || snapshot.text) fail('Non-text sizing snapshots cannot carry text authority')

  for (const axis of ['width', 'height'] as const) {
    const actual = snapshot.axes[axis]
    if (!positive(actual.measured) || actual.measured !== snapshot.measured[axis]) fail('Paper sizing snapshot measurements are inconsistent')
    if (actual.stored) checkedStoredAxis(actual.stored)
    if (actual.fixedPx !== undefined && !positive(actual.fixedPx)) fail('Paper sizing snapshot fixed dimensions must be positive')
    if (actual.intent === 'relative') checkedRelative(actual.relativeValue ?? (actual.stored?.value.kind === 'percent' ? actual.stored.value.value : undefined), snapshot.kind)
    const expected = axisIntent(axis, snapshot.kind, sourcePosition, sourceLayout?.item[axis], snapshot.primitiveSize?.[axis], snapshot.textProperties?.textSizing)
    expected.measured = snapshot.measured[axis]
    if (!same(actual, expected)) fail('Paper sizing snapshot intent does not match its source authority')
  }
}

function resolveAxis(transition: PaperSizingTransition, axis: PaperAxis): PaperAxisDecision {
  const { snapshot, targetPosition, targetParent, capabilities } = transition
  const override = transition.overrides?.[axis]
  if (override) {
    if (!capability(capabilities[axis], override.intent)) fail(`Paper ${axis} sizing override is unsupported in the target context`)
    return checkedDecision(override, snapshot.kind)
  }
  const source = snapshot.axes[axis]
  const crossing = snapshot.fromFamily !== familyOf(targetPosition)
  const absoluteToFlow = snapshot.sourcePosition.mode === 'absolute' && targetPosition.mode === 'flow'
  const text = snapshot.text

  if (snapshot.kind === 'text' && axis === 'height' && text?.editable && source.intent !== 'fixed' && (crossing || absoluteToFlow || !capability(capabilities.height, source.intent))) {
    if (!capabilities.height.fit) fail('Editable text requires Fit height in the target context')
    return fitDecision()
  }
  if (snapshot.kind === 'text' && axis === 'width' && source.intent === 'inline-text') {
    if (!text?.multiline) return capabilities.width.fit ? fitDecision() : fixedDecision(source.measured)
    const columnLike = targetParent.display === 'block' || targetParent.display === 'flex' && targetParent.flexDirection?.startsWith('column')
    return columnLike && capabilities.width.fill ? fillDecision() : fixedDecision(source.measured)
  }
  if (source.intent === 'fixed') return fixedDecision(source.fixedPx ?? source.measured)
  if (absoluteToFlow) return fixedDecision(source.measured)
  if (['fill', 'relative', 'constrained'].includes(source.intent) && crossing) return fixedDecision(source.measured)
  if (source.intent === 'fit') return capabilities[axis].fit ? preservedDecision(source) : fixedDecision(source.measured)
  if (source.intent === 'auto' && crossing) return fixedDecision(source.measured)
  return capability(capabilities[axis], source.intent) ? preservedDecision(source) : fixedDecision(source.measured)
}

function axisSize(decision: PaperAxisDecision): AxisSize | undefined {
  if (decision.intent === 'fixed') return decision.fixedPx === undefined ? undefined : { value: { kind: 'px', value: decision.fixedPx } }
  if (decision.intent === 'fit') return decision.stored?.value.kind === 'intrinsic' ? clone(decision.stored) : { value: { kind: 'intrinsic', value: 'fit-content' } }
  if (decision.intent === 'fill') return { value: { kind: 'percent', value: 100 } }
  if (decision.intent === 'relative') {
    const value = decision.relativeValue ?? (decision.stored?.value.kind === 'percent' ? decision.stored.value.value : undefined)
    return { value: { kind: 'percent', value: checkedRelative(value, 'component') } }
  }
  if (decision.intent === 'auto') return { value: { kind: 'auto' } }
  if (decision.intent === 'constrained') return decision.stored ? clone(decision.stored) : undefined
}

function normalizedPosition(position: NodePosition, width: PaperAxisDecision, height: PaperAxisDecision): NodePosition {
  if (position.mode !== 'absolute') return { mode: position.mode }
  const next = clone(position)
  if (width.intent === 'fixed' && next.left !== undefined && next.right !== undefined) delete next.right
  if (height.intent === 'fixed' && next.top !== undefined && next.bottom !== undefined) delete next.bottom
  return next
}

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

export function reconcilePaperSizing(transition: PaperSizingTransition): PaperSizingTarget {
  checkedSnapshot(transition.snapshot)
  checkedCapabilities(transition.capabilities)
  checkedParent(transition.targetParent)
  const width = resolveAxis(transition, 'width')
  const height = resolveAxis(transition, 'height')
  const source = transition.snapshot.sourceLayout
  const item = clone(source?.item ?? { position: transition.snapshot.sourcePosition })
  item.position = normalizedPosition(transition.targetPosition, width, height)
  delete item.width
  delete item.height
  const targetFamily = familyOf(item.position)
  const acceptsFlexItem = targetFamily === 'flow' && transition.targetParent.display === 'flex'
  const acceptsGridItem = targetFamily === 'flow' && transition.targetParent.display === 'grid'
  if (!acceptsFlexItem) delete item.flex
  if (!acceptsGridItem) delete item.grid

  if (transition.snapshot.kind !== 'text') {
    const widthSize = axisSize(width)
    const heightSize = axisSize(height)
    if (transition.snapshot.kind === 'component' || width.intent !== 'fixed') { if (widthSize) item.width = widthSize }
    if (transition.snapshot.kind === 'component' || height.intent !== 'fixed') { if (heightSize) item.height = heightSize }
  }
  if (transition.snapshot.kind === 'primitive' && item.position.mode === 'freeform') {
    delete item.aspectRatio
    delete item.flex
    delete item.grid
    delete item.transform
  }
  const layout: NodeLayout = {
    item,
    ...(source?.container ? { container: clone(source.container) } : {}),
    ...(source?.spacing ? { spacing: clone(source.spacing) } : {}),
  }
  if (!isValidLayout(layout)) fail('Paper sizing produced an invalid target layout')
  const target: PaperSizingTarget = { nodeId: transition.snapshot.nodeId, layout }

  if (transition.snapshot.kind !== 'component') {
    const original = transition.snapshot.primitiveSize!
    const next = {
      width: width.intent === 'fixed' ? width.fixedPx ?? transition.snapshot.measured.width : original.width,
      height: height.intent === 'fixed' ? height.fixedPx ?? transition.snapshot.measured.height : original.height,
    }
    if (!same(next, original)) target.styles = next
  }

  if (transition.snapshot.kind === 'text') {
    const original = transition.snapshot.textProperties!
    const textSizing: TextSizing = {
      width: width.intent === 'relative'
        ? { mode: 'relative', value: checkedRelative(width.relativeValue ?? (width.stored?.value.kind === 'percent' ? width.stored.value.value : undefined), 'text') }
        : { mode: width.intent === 'fit' ? 'fit' : width.intent === 'fill' ? 'fill' : 'fixed' },
      height: height.intent === 'relative'
        ? { mode: 'relative', value: checkedRelative(height.relativeValue ?? (height.stored?.value.kind === 'percent' ? height.stored.value.value : undefined), 'text') }
        : { mode: height.intent === 'fit' ? 'fit' : height.intent === 'fill' ? 'fill' : 'fixed' },
    }
    const textStyle = clone(original.textStyle)
    if (textSizing.height.mode !== 'fit') delete textStyle.maxLines
    const textProperties = { textStyle, textSizing }
    if (!same(textProperties, original)) target.textProperties = textProperties
  }
  return target
}

function requireDecision(intent: PaperAxisIntent, snapshot: PaperAxisSnapshot, capabilities: PaperAxisCapabilities, fallback: number, targetKind: PaperSizingKind): PaperAxisDecision {
  if (intent === 'inline-text') intent = 'fit'
  if (!capability(capabilities, intent)) return fixedDecision(fallback)
  if (intent === 'constrained' && !snapshot.stored) return fixedDecision(fallback)
  try { return checkedDecision(preservedDecision({ ...snapshot, intent }), targetKind) } catch { return fixedDecision(fallback) }
}

const dependent = (axis: PaperAxisSnapshot): boolean => ['fill', 'relative', 'constrained'].includes(axis.intent)

export function planPaperAddSizing(input: PaperAddSizingInput): PaperAddSizingPlan {
  checkedMeasured(input.inferred)
  checkedSnapshot(input.parent)
  checkedCapabilities(input.parentCapabilities)
  for (const child of input.children) {
    checkedSnapshot(child.snapshot)
    checkedCapabilities(child.capabilities)
  }
  const childAxes = input.children.map(child => ({ nodeId: child.snapshot.nodeId, axes: {} as Partial<Record<PaperAxis, PaperAxisDecision>> }))
  const parentAxes = {} as { width: PaperAxisDecision; height: PaperAxisDecision }

  for (const axis of ['width', 'height'] as const) {
    const source = input.parent.axes[axis]
    const inferred = input.inferred[axis]
    if (source.intent === 'fixed') {
      if (!input.parentCapabilities[axis].fit) fail(`Add Flex requires Fit ${axis} for a fixed parent`)
      parentAxes[axis] = fitDecision(source.measured)
      continue
    }
    if (source.intent !== 'auto') {
      parentAxes[axis] = requireDecision(source.intent, source, input.parentCapabilities[axis], inferred, input.parent.kind)
      continue
    }
    const dependents = input.children.map((child, index) => ({ child, index })).filter(entry => dependent(entry.child.snapshot.axes[axis]))
    if (dependents.length === 0) {
      if (input.parentIsFlexChild) {
        if (!input.parentCapabilities[axis].fill) fail(`A Flex-child parent requires Fill ${axis}`)
        parentAxes[axis] = fillDecision()
      } else {
        if (!input.parentCapabilities[axis].fit) fail(`Add Flex requires Fit ${axis} for an auto parent`)
        parentAxes[axis] = fitDecision()
      }
    } else if (dependents.length === 1) {
      const { child, index } = dependents[0]!
      const transferred = requireDecision(child.snapshot.axes[axis].intent, child.snapshot.axes[axis], input.parentCapabilities[axis], inferred, input.parent.kind)
      if (transferred.intent === 'fixed') parentAxes[axis] = fixedDecision(inferred)
      else {
        if (!child.capabilities[axis].fill) fail(`The dependent child cannot become Fill ${axis}`)
        parentAxes[axis] = transferred
        childAxes[index]!.axes[axis] = fillDecision()
      }
    } else parentAxes[axis] = fixedDecision(inferred)
  }

  return { parentAxes, childAxes }
}
