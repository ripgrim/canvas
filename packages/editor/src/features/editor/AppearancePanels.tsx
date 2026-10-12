import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { applyColorOpacity, canonicalAppearance, convertPaint, defaultOutline } from '@canvas/repo-engine/appearance'
import type { Appearance, BlendMode, BorderSide, ColorValue, GradientInterpolation, GradientPaint, GradientShape, ImagePaint, Outline, Paint, Stroke, StrokeStyle } from '@canvas/repo-engine/appearance'
import { resolveColorValue } from '@canvas/repo-engine/file-document'
import type { FileDocument, SourcePalette } from '@canvas/repo-engine/file-document'
import { colorToCss, colorToHex, hexColor } from '@canvas/repo-engine/color'
import type { Color } from '@canvas/repo-engine/color'
import { InspectorColorField, InspectorIconButton, InspectorNumberField, InspectorPaintStop, splitHex } from '../../design-system/inspector-atoms'
import { AppearanceDragHandle, AppearanceFieldGlyph, AppearanceFilePicker, AppearanceImagePreview, AppearanceItem, AppearanceLine, AppearanceList, AppearanceMixedButton, AppearanceRemoveButton, AppearanceSection, AppearanceSegments, AppearanceSelect, AppearanceSpacer, AppearanceVisibilityButton, GradientBar } from '../../design-system/appearance-atoms'
import type { DragSession, FilePickerHandle } from '../../design-system/appearance-atoms'
import { ColorPicker } from '../../design-system/color-picker'
import { MissingTokenField, MixedTokensField, TokenActionButton, TokenActions, TokenBoundField, TokenChooser } from '../../design-system/token-field-atoms'
import { aggregateBlending, aggregateBorders, aggregateFills, aggregateOutline, bindingState, blendModeGroups, borderEntries, colorAt, colorAtSlot, colorTokenOptions, darkerHex, editStroke, effectiveAppearance, eligibleFor, entriesToBorders, gradientBarCss, mergePaint, midpointAt, midpointHandles, moveItem, overridesFor, rebindColor, storageIndex, unlinkColor, UnresolvedTokenError, withBorder, withColorAtSlot, withFill, withFills, withOutline, withoutStop, withPaintBlend, withPaintOpacity, withPaintVisibility, withStop, withStrokeVisibility } from './appearance-adapters'
import type { BindingEntry, BindingState, BorderEntry, BorderKey, ColorSlot, FillField, StrokeField, StyledNode } from './appearance-adapters'
import { documentStore } from './document-store'
import { inspectorCopy as copy } from './inspector-copy'
import { tokenFieldCopy as tokenCopy } from './token-field-copy'
import { loadDefaultImage } from '../../services/default-image'

type Mode = 'light' | 'dark'
type Target = { id: string; node: StyledNode; appearance: Appearance | undefined }
/** `paletteOf` resolves a node's bound tokens in that node's own effective theme. */
type Context = { file: FileDocument; paletteOf: (nodeId: string) => SourcePalette; mode: Mode; disabled: boolean; targets: Target[]; ids: string[] }

const fallbackColor = hexColor('#000000')
const maxFills = 16
const maxStops = 16
const imageAccept = 'image/*'
const newId = () => crypto.randomUUID()
const literal = (hex: string): ColorValue => ({ kind: 'literal', color: hexColor(hex) })
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const round = (value: number) => Math.round(value * 1000) / 1000

const commands = () => documentStore.commands.appearance
const blendGroups = blendModeGroups.map(group => group.map(mode => ({ value: mode, label: copy.blendModes[mode] })))
const strokeStyles = (Object.keys(copy.strokeStyles) as StrokeStyle[]).map(style => ({ value: style, label: copy.strokeStyles[style] }))

/** Writes a different appearance per node as one undo step, through the gesture batch. */
function commitEach(targets: readonly Target[], update: (appearance: Appearance | undefined, target: Target) => Appearance | undefined): boolean {
  const gesture = commands().gesture
  gesture.begin()
  gesture.preview(overridesFor(targets, update))
  return gesture.commit()
}

/** A pointer drag that previews per node without history and commits once. */
function liveEdit(targets: readonly Target[], update: (appearance: Appearance | undefined, value: number) => Appearance | undefined): DragSession<number> {
  const gesture = commands().gesture
  gesture.begin()
  return { move: value => gesture.preview(overridesFor(targets, appearance => update(appearance, value))), end: () => { gesture.commit() }, cancel: () => gesture.cancel() }
}

/** Targets re-read from the store, for handlers that resume after an await. */
function freshTargets(ids: readonly string[]): Target[] {
  const file = documentStore.getSnapshot().file
  return ids.flatMap(id => { const node = file?.nodes[id]; return node && node.type !== 'root' ? [{ id, node, appearance: node.appearance }] : [] })
}

type ColorLabels = { binding: string; color: string; opacity: string }
type ColorPartsProps = { id: string; context: Context; slot: ColorSlot; value: ColorValue; mixed?: boolean; labels: ColorLabels; picker?: { open: boolean; onOpenChange: (open: boolean) => void }; opacity?: number; opacityMixed?: boolean; onOpacityChange?: (opacity: number) => void; onChange: (value: ColorValue) => void; onBindingAction?: () => void }
type ColorParts = { bound: boolean; binding: ReactNode; color: ReactNode }

/** The color stored at one slot on every selected node that has it. */
const slotEntries = (targets: readonly Target[], slot: ColorSlot): BindingEntry[] => targets.flatMap(target => { const value = colorAtSlot(target.appearance, slot); return value ? [{ nodeId: target.id, value }] : [] })
const isLiteralState = (state: BindingState) => state.kind === 'empty' || state.kind === 'literal' || state.kind === 'mixed-literals'
const shownColor = (color: Color) => { const parts = splitHex(colorToHex(color)) ?? { rgb: '#000000', opacity: 100 }; return { hex: parts.rgb.toUpperCase(), opacity: parts.opacity } }
const chooserOptions = (context: Context) => {
  const first = context.targets[0]
  const palette = first ? context.paletteOf(first.id) : {}
  return colorTokenOptions(context.file).map(option => {
    const color = resolveColorValue(context.file.theme, { kind: 'token', tokenId: option.value }, palette)
    return { ...option, ...(color ? { color: colorToCss(color) } : {}) }
  })
}

/** Rebind writes the stable token id at this slot on every selected node, as one undo step; nodes already bound to it are skipped. */
function rebindSlot(context: Context, slot: ColorSlot, tokenId: string): boolean {
  const targets = context.targets.filter(target => { const value = colorAtSlot(target.appearance, slot); return value !== undefined && rebindColor(value, tokenId) !== value })
  if (!targets.length) return false
  return commitEach(targets, appearance => { const value = colorAtSlot(appearance, slot); return value ? withColorAtSlot(appearance, slot, rebindColor(value, tokenId)) : appearance })
}

/** Unlink detaches each bound node to the literal its own effective theme resolves to; literals stay. One undo step. */
function unlinkSlot(context: Context, slot: ColorSlot): boolean {
  const { file } = context
  let changes: { target: Target; value: ColorValue }[]
  try {
    changes = context.targets.flatMap(target => {
      const value = colorAtSlot(target.appearance, slot)
      return value?.kind === 'token' ? [{ target, value: unlinkColor(file, target.id, value, documentStore.paletteFor(target.id)) }] : []
    })
  } catch (error) {
    if (error instanceof UnresolvedTokenError) return false
    throw error
  }
  if (!changes.length) return false
  const literals = new Map(changes.map(change => [change.target.id, change.value]))
  return commitEach(changes.map(change => change.target), (appearance, target) => withColorAtSlot(appearance, slot, literals.get(target.id)!))
}

/** A color source select (literal or a theme token) and the editable color field. Editing the color makes it literal. */
function literalParts({ id, context, value, mixed = false, labels, picker, onChange }: ColorPartsProps): ColorParts {
  const { file, mode, disabled, targets } = context
  const resolved = resolveColorValue(file.theme, value, targets[0] ? context.paletteOf(targets[0].id) : {})
  const hex = colorToHex(resolved ?? fallbackColor)
  const commit = (next: string) => onChange(literal(next))
  return {
    bound: false,
    binding: <TokenChooser id={`${id}-binding`} label={labels.binding} placeholder={labels.binding} options={chooserOptions(context)} disabled={disabled} onChoose={tokenId => onChange({ kind: 'token', tokenId })} />,
    color: <InspectorColorField id={`${id}-color`} label={labels.color} opacityLabel={labels.opacity} value={hex} {...(mixed ? { mixed: copy.mixed } : {})} disabled={disabled} swatch={<ColorPicker variant="swatch" label={labels.color} value={hex} mode={mode} disabled={disabled} onChange={commit} {...(picker ?? {})} />} onCommit={commit} />,
  }
}

/**
 * A bound slot: the token in the value position with read-only opacity context and explicit Rebind and Unlink actions.
 * Nothing here edits the color, so a binding cannot be replaced by accident.
 */
function boundParts({ id, context, slot, labels, opacity, opacityMixed = false, onOpacityChange, onBindingAction }: ColorPartsProps, state: Exclude<BindingState, { kind: 'empty' | 'literal' | 'mixed-literals' }>, entries: readonly BindingEntry[]): ColorParts {
  const { file, disabled } = context
  const target = labels.color
  const diagnosticId = `${id}-diagnostic`
  const acted = (done: boolean) => { if (done) onBindingAction?.() }
  const multiple = state.kind === 'mixed-tokens' || state.kind === 'mixed-sources'
  const rebind = <TokenChooser id={`${id}-rebind`} label={multiple ? tokenCopy.rebindAllLabel(target) : tokenCopy.rebindLabel(target)} placeholder={multiple ? tokenCopy.rebindAll : tokenCopy.rebind} options={chooserOptions(context)} disabled={disabled} onChoose={tokenId => acted(rebindSlot(context, slot, tokenId))} />
  const unlinkable = state.kind === 'bound' || (multiple && state.unlinkable)
  const unlink = <TokenActionButton label={multiple ? tokenCopy.unlinkEachLabel(target) : tokenCopy.unlinkLabel(target)} icon="unlink" disabled={disabled} reason={unlinkable ? undefined : tokenCopy.unlinkUnavailable} describedBy={diagnosticId} onClick={() => acted(unlinkSlot(context, slot))} />
  if (state.kind === 'bound') {
    const colors = entries.map(entry => resolveColorValue(file.theme, entry.value, context.paletteOf(entry.nodeId)) ?? fallbackColor)
    const primary = shownColor(colors[0]!)
    const varies = colors.some(color => colorToHex(color) !== colorToHex(colors[0]!))
    const colorText = varies ? tokenCopy.variesByTheme : tokenCopy.colorText(primary.hex, primary.opacity)
    const contextText = state.aliasOf ? tokenCopy.aliasTo(state.aliasOf.name) : varies ? tokenCopy.variesByTheme : tokenCopy.context(primary.hex, primary.opacity)
    const detail = state.aliasOf ? `${tokenCopy.aliasTo(state.aliasOf.name)}, ${colorText}` : colorText
    const swatch = applyColorOpacity(colors[0]!, opacity)
    return { bound: true, color: <TokenBoundField id={`${id}-opacity`} label={tokenCopy.boundLabel(target, state.token.name, detail)} color={colorToCss(swatch)} name={state.token.name} context={contextText} opacity={opacity} opacityLabel={labels.opacity} opacityMixed={opacityMixed} disabled={disabled} onOpacityCommit={onOpacityChange} />, binding: <TokenActions>{rebind}{unlink}</TokenActions> }
  }
  if (multiple) {
    const text = state.kind === 'mixed-tokens' ? tokenCopy.mixedTokens : tokenCopy.mixedSources
    return { bound: true, color: <MixedTokensField label={tokenCopy.stateLabel(target, text)} text={text} />, binding: <TokenActions>{rebind}{unlink}</TokenActions> }
  }
  const text = state.kind === 'missing' ? tokenCopy.missingToken(state.tokenId) : state.kind === 'incompatible' ? tokenCopy.incompatible : tokenCopy.unresolved[state.problem](state.token.name)
  return {
    bound: true,
    color: <MissingTokenField id={diagnosticId} label={tokenCopy.stateLabel(target, text)} text={text} />,
    binding: <TokenActions>{rebind}{unlink}</TokenActions>,
  }
}

/** Literal colors keep today's source select and editable field; any token at the slot switches to the bound presentation. */
function colorParts(props: ColorPartsProps): ColorParts {
  const entries = slotEntries(props.context.targets, props.slot)
  const state = bindingState(entries, props.context.file)
  if (isLiteralState(state)) return literalParts({ ...props, mixed: Boolean(props.mixed) || state.kind === 'mixed-literals' })
  return boundParts(props, state as Exclude<BindingState, { kind: 'empty' | 'literal' | 'mixed-literals' }>, entries)
}

function ColorLine(props: ColorPartsProps & { trailing?: ReactNode }) {
  const parts = colorParts(props)
  return <AppearanceLine layout="value-actions">{parts.color}{parts.binding}{props.trailing}</AppearanceLine>
}

// Blending ----------------------------------------------------------------------------------------------------------

function BlendingSection({ context }: { context: Context }) {
  const aggregate = aggregateBlending(context.targets.map(target => target.appearance))
  if (aggregate.state === 'absent') return null
  const mixed: readonly string[] = aggregate.state === 'field-mixed' ? aggregate.mixed : []
  const value = aggregate.value
  // Patches name only the edited field, so changing opacity or blend keeps hidden layers hidden.
  const set = (patch: { visible?: boolean; opacity?: number; blendMode?: BlendMode }) => { commands().setBlending(context.ids, patch) }
  const scrubOpacity = () => liveEdit(context.targets, (appearance, opacity) => canonicalAppearance({ ...(appearance ?? {}), opacity: opacity / 100 }))
  const visible = value.visible && !mixed.includes('visible')
  return <AppearanceSection id="blending" title={copy.blending} disabled={context.disabled} actions={<AppearanceVisibilityButton visible={visible} showLabel={copy.showLayer} hideLabel={copy.hideLayer} disabled={context.disabled} onChange={next => set({ visible: next })} />}>
    <AppearanceLine>
      <InspectorNumberField id="blending-opacity" label={copy.opacity} prefix={<AppearanceFieldGlyph name="opacity" />} suffix="%" value={mixed.includes('opacity') ? null : Math.round(value.opacity * 100)} placeholder={copy.mixed} min={0} max={100} disabled={context.disabled} onCommit={opacity => set({ opacity: opacity / 100 })} onScrubStart={scrubOpacity} />
      <AppearanceSelect id="blending-mode" label={copy.blendMode} value={mixed.includes('blendMode') ? null : value.blendMode} placeholder={copy.mixed} groups={blendGroups} disabled={context.disabled} onChange={mode => set({ blendMode: mode as BlendMode })} />
    </AppearanceLine>
  </AppearanceSection>
}

// Fill --------------------------------------------------------------------------------------------------------------

function FillSection({ context }: { context: Context }) {
  const aggregate = aggregateFills(context.targets.map(target => target.appearance))
  const full = context.targets.some(target => (target.appearance?.fills?.length ?? 0) >= maxFills)
  const add = () => { commands().addFill(context.ids) }
  if (aggregate.state === 'absent') return <AppearanceSection id="fill" title={copy.fill} absent addLabel={copy.addFill} onAdd={add} disabled={context.disabled} />
  if (aggregate.state === 'structure-mixed') return <AppearanceSection id="fill" title={copy.fill} addLabel={copy.addFill} onAdd={add} disabled={context.disabled || full}>
    <AppearanceMixedButton label={copy.replaceMixedFills} disabled={context.disabled} onClick={() => { commands().replaceFills(context.ids, aggregate.value) }} />
  </AppearanceSection>
  const fills = aggregate.value
  const count = fills.length
  const rows = Array.from({ length: count }, (_, row) => {
    const index = storageIndex(row, count)
    return <FillRow key={fills[index]!.id} context={context} paint={fills[index]!} index={index} row={row} count={count} mixed={aggregate.state === 'field-mixed' ? aggregate.mixed[index] ?? [] : []} />
  })
  return <AppearanceSection id="fill" title={copy.fill} addLabel={copy.addFill} onAdd={add} disabled={context.disabled || full}>
    <AppearanceList label={copy.fills}>{rows}</AppearanceList>
  </AppearanceSection>
}

type FillRowProps = { context: Context; paint: Paint; index: number; row: number; count: number; mixed: readonly FillField[] }

function FillRow({ context, paint, index, row, count, mixed }: FillRowProps) {
  const picker = useRef<FilePickerHandle | null>(null)
  const { ids, targets, disabled, file } = context
  const number = row + 1
  const isMixed = (field: FillField) => mixed.includes(field)
  /** One edited paint: uniform rows write it to every node; mixed rows copy only the changed fields. */
  const write = (next: Paint) => {
    if (!mixed.length) commands().updateFill(ids, index, next)
    else commitEach(targets, appearance => withFill(appearance, index, current => mergePaint(current, paint, next)))
  }
  const live = (update: (value: number) => Paint): DragSession<number> => liveEdit(targets, (appearance, value) => withFill(appearance, index, current => mergePaint(current, paint, update(value))))
  const moveTo = (to: number) => { if (to >= 0 && to < count && to !== row) commands().moveFill(ids, index, storageIndex(to, count)) }
  const dragStart = (): DragSession<number> => {
    const gesture = commands().gesture
    gesture.begin()
    return {
      move: to => gesture.preview(overridesFor(targets, appearance => appearance?.fills?.length === count ? withFills(appearance, moveItem(appearance.fills, index, storageIndex(to, count))) : appearance)),
      end: () => { gesture.commit() },
      cancel: () => gesture.cancel(),
    }
  }
  /** Each node seeds its second stop from the color its own theme resolves. */
  const secondStop = (nodeId: string) => (color: ColorValue): ColorValue => { const resolved = resolveColorValue(file.theme, color, context.paletteOf(nodeId)); return resolved ? literal(darkerHex(colorToHex(resolved))) : color }
  const chooseImage = async (source: File) => {
    const assetId = await documentStore.commands.assets.add(source)
    if (!assetId) return
    commitEach(freshTargets(ids), (appearance, target) => withFill(appearance, index, current => current.type === 'image'
      ? { ...current, assetId }
      : convertPaint({ ...current, cache: { ...(current.cache ?? {}), image: { assetId, fit: current.cache?.image?.fit ?? 'cover' } } }, 'image', newId, secondStop(target.id))))
  }
  const convert = async (type: Paint['type']) => {
    const fills = targets.map(target => target.appearance?.fills?.[index])
    if (type === 'image' && fills.some(current => current && current.type !== 'image' && !current.cache?.image)) {
      try {
        await chooseImage(await loadDefaultImage())
      } catch { picker.current?.open() }
      return
    }
    commitEach(targets, (appearance, target) => withFill(appearance, index, current => convertPaint(current, type, newId, secondStop(target.id))))
  }
  const typeOptions = [{ value: 'solid' as const, label: copy.solid, glyph: 'solid' as const }, { value: 'gradient' as const, label: copy.gradient, glyph: 'gradient' as const }, { value: 'image' as const, label: copy.image, glyph: 'image' as const }]
  return <AppearanceItem label={copy.fillItem(number)} onMoveBy={delta => moveTo(row + delta)}>
    <AppearanceLine>
      <AppearanceDragHandle label={copy.reorderFill(number)} disabled={disabled || count < 2} onDragStart={dragStart} />
      <AppearanceSegments label={copy.fillType(number)} value={paint.type} options={typeOptions} disabled={disabled} onChange={type => { void convert(type) }} />
      {index > 0
        ? <AppearanceSelect id={`fill-${paint.id}-blend`} label={copy.fillBlend(number)} value={isMixed('blendMode') ? null : paint.blendMode ?? 'normal'} placeholder={copy.mixed} groups={blendGroups} disabled={disabled} onChange={mode => write(withPaintBlend(paint, mode as BlendMode))} />
        : <AppearanceSpacer />}
      <AppearanceVisibilityButton visible={paint.visible !== false && !isMixed('visible')} showLabel={copy.showFill(number)} hideLabel={copy.hideFill(number)} disabled={disabled} onChange={visible => write(withPaintVisibility(paint, visible))} />
      <AppearanceRemoveButton label={copy.removeFill(number)} disabled={disabled} onClick={() => { commands().removeFill(ids, index) }} />
    </AppearanceLine>
    {paint.type === 'solid' && <ColorLine id={`fill-${paint.id}`} context={context} slot={{ kind: 'fill', index }} value={paint.color} mixed={isMixed('color')} opacity={paint.opacity ?? 1} opacityMixed={isMixed('opacity')} labels={{ binding: copy.fillBinding(number), color: copy.fillColor(number), opacity: copy.fillOpacity(number) }} onOpacityChange={opacity => write(withPaintOpacity(paint, opacity))} onChange={color => write({ ...paint, color })} />}
    {paint.type === 'gradient' && <GradientBody context={context} paint={paint} index={index} number={number} isMixed={isMixed} write={write} live={live} />}
    {paint.type === 'image' && <ImageBody context={context} paint={paint} number={number} isMixed={isMixed} write={write} onChoose={() => picker.current?.open()} />}
    <AppearanceFilePicker label={copy.imageFile(number)} accept={imageAccept} disabled={disabled} pickerRef={picker} onFile={file => { void chooseImage(file) }} />
  </AppearanceItem>
}

type BodyProps<P extends Paint> = { context: Context; paint: P; number: number; isMixed: (field: FillField) => boolean; write: (paint: Paint) => void }

function GradientBody({ context, paint, index, number, isMixed, write, live }: BodyProps<GradientPaint> & { index: number; live: (update: (value: number) => Paint) => DragSession<number> }) {
  const [active, setActive] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const { file, disabled, targets } = context
  const current = Math.min(active, paint.stops.length - 1)
  const stop = paint.stops[current]!
  // The bar shows the first selected node's colors; an unresolvable stop is drawn transparent, never as a guessed color.
  const palette = targets[0] ? context.paletteOf(targets[0].id) : {}
  const css = (value: ColorValue) => { const resolved = resolveColorValue(file.theme, value, palette); return resolved ? colorToCss(resolved) : 'transparent' }
  const hexOf = (value: ColorValue) => colorToHex(resolveColorValue(file.theme, value, palette) ?? fallbackColor)
  const stopSlot = (stopIndex: number): ColorSlot => ({ kind: 'stop', index, stop: stopIndex })
  /** The picker only opens on a literal stop; a bound stop has no editable color to open. */
  const openPicker = (stopIndex: number) => { setActive(stopIndex); if (isLiteralState(bindingState(slotEntries(targets, stopSlot(stopIndex)), file))) setPickerOpen(true) }
  const shapes = (Object.keys(copy.shapes) as GradientShape[]).map(shape => ({ value: shape, label: copy.shapes[shape] }))
  const interpolations = (Object.keys(copy.interpolations) as GradientInterpolation[]).map(value => ({ value, label: copy.interpolations[value] }))
  const order = [...paint.stops.keys()].sort((left, right) => paint.stops[left]!.position - paint.stops[right]!.position || left - right)
  const stopNumber = (index: number) => order.indexOf(index) + 1
  const add = (position: number) => {
    if (paint.stops.length >= maxStops) return
    const color = colorAt(paint.stops.map(item => ({ position: item.position, hex: hexOf(item.color) })), position)
    write({ ...paint, stops: [...paint.stops, { id: newId(), position, color: literal(color) }] })
    setActive(paint.stops.length)
  }
  const remove = (index: number) => {
    if (paint.stops.length <= 2) return
    write(withoutStop(paint, index))
    setActive(selected => selected > index ? selected - 1 : Math.min(selected, paint.stops.length - 2))
  }
  const stopLabels = { binding: copy.stopBinding(stopNumber(current)), color: copy.stopColor(stopNumber(current)), opacity: copy.stopOpacity(stopNumber(current)) }
  const parts = colorParts({ id: `fill-${paint.id}-stop`, context, slot: stopSlot(current), value: stop.color, mixed: isMixed('stops'), labels: stopLabels, picker: { open: pickerOpen, onOpenChange: setPickerOpen }, onChange: color => write(withStop(paint, current, { color })), onBindingAction: () => setPickerOpen(false) })
  return <>
    <AppearanceLine>
      <AppearanceSelect id={`fill-${paint.id}-shape`} label={copy.shape(number)} value={isMixed('shape') ? null : paint.shape} placeholder={copy.mixed} options={shapes} disabled={disabled} onChange={shape => write({ ...paint, shape: shape as GradientShape })} />
      {paint.shape === 'radial'
        ? <AppearanceSpacer />
        : <InspectorNumberField id={`fill-${paint.id}-angle`} label={copy.angle(number)} prefix={<AppearanceFieldGlyph name="angle" />} suffix="°" value={isMixed('angle') ? null : paint.angle} placeholder={copy.mixed} min={-360} max={360} disabled={disabled} onCommit={angle => write({ ...paint, angle })} onScrubStart={() => live(angle => ({ ...paint, angle }))} />}
    </AppearanceLine>
    <AppearanceLine>
      <InspectorNumberField id={`fill-${paint.id}-center-x`} label={copy.centerX(number)} prefix="X" suffix="%" value={isMixed('center') ? null : Math.round(paint.center.x * 100)} placeholder={copy.mixed} min={-200} max={300} disabled={disabled} onCommit={x => write({ ...paint, center: { ...paint.center, x: x / 100 } })} onScrubStart={() => live(x => ({ ...paint, center: { ...paint.center, x: x / 100 } }))} />
      <InspectorNumberField id={`fill-${paint.id}-center-y`} label={copy.centerY(number)} prefix="Y" suffix="%" value={isMixed('center') ? null : Math.round(paint.center.y * 100)} placeholder={copy.mixed} min={-200} max={300} disabled={disabled} onCommit={y => write({ ...paint, center: { ...paint.center, y: y / 100 } })} onScrubStart={() => live(y => ({ ...paint, center: { ...paint.center, y: y / 100 } }))} />
    </AppearanceLine>
    <AppearanceLine>
      <InspectorNumberField id={`fill-${paint.id}-length`} label={copy.length(number)} prefix={<AppearanceFieldGlyph name="length" />} suffix="%" value={isMixed('length') ? null : Math.round(paint.length * 100)} placeholder={copy.mixed} min={1} max={1000} disabled={disabled} onCommit={length => write({ ...paint, length: length / 100 })} onScrubStart={() => live(length => ({ ...paint, length: length / 100 }))} />
      <AppearanceSelect id={`fill-${paint.id}-interpolation`} label={copy.interpolation(number)} value={isMixed('interpolation') ? null : paint.interpolation} placeholder={copy.mixed} options={interpolations} disabled={disabled} onChange={value => write({ ...paint, interpolation: value as GradientInterpolation })} />
    </AppearanceLine>
    <GradientBar label={copy.stops(number)} background={gradientBarCss(paint.stops.map(item => ({ position: item.position, ...(item.midpoint === undefined ? {} : { midpoint: item.midpoint }), css: css(item.color) })))} active={current} disabled={disabled}
      stops={paint.stops.map((item, index) => ({ key: item.id, position: item.position, color: css(item.color), label: copy.stop(stopNumber(index)) }))}
      midpoints={midpointHandles(paint.stops).map(handle => ({ key: `${paint.stops[handle.stopIndex]!.id}-midpoint`, stopIndex: handle.stopIndex, position: handle.position, value: paint.stops[handle.stopIndex]!.midpoint ?? 0.5, label: copy.midpoint(stopNumber(handle.stopIndex)) }))}
      onSelect={setActive}
      onStopDrag={index => live(position => withStop(paint, index, { position }))}
      onMidpointDrag={index => live(position => withStop(paint, index, { midpoint: midpointAt(paint.stops, index, position) }))}
      onAdd={add}
      onRemove={remove}
      onOpen={openPicker}
      onNudge={(index, delta) => write(withStop(paint, index, { position: round(clamp(paint.stops[index]!.position + delta, 0, 1)) }))}
      onMidpointNudge={(index, delta) => write(withStop(paint, index, { midpoint: round(clamp((paint.stops[index]!.midpoint ?? 0.5) + delta, 0.01, 0.99)) }))}
      onResetMidpoint={index => write(withStop(paint, index, { midpoint: 0.5 }))} />
    <AppearanceLine><InspectorPaintStop label={copy.stop(stopNumber(current))}
      position={<InspectorNumberField id={`fill-${paint.id}-stop-position`} label={copy.stopPosition(stopNumber(current))} prefix={<AppearanceFieldGlyph name="position" />} suffix="%" value={isMixed('stops') ? null : Math.round(stop.position * 100)} placeholder={copy.mixed} min={0} max={100} disabled={disabled} onCommit={position => write(withStop(paint, current, { position: position / 100 }))} onScrubStart={() => live(position => withStop(paint, current, { position: position / 100 }))} />}
      color={parts.color}
      binding={parts.binding}
      action={<InspectorIconButton label={copy.removeStop(stopNumber(current))} icon="minus" disabled={disabled || paint.stops.length <= 2} onClick={() => remove(current)} />} /></AppearanceLine>
  </>
}

function ImageBody({ context, paint, isMixed, onChoose }: BodyProps<ImagePaint> & { onChoose: () => void }) {
  const { file, disabled } = context
  const asset = isMixed('assetId') ? undefined : file.assets?.[paint.assetId]
  const preview = asset ? documentStore.assetPreview(asset.id) : null
  return <AppearanceLine>
    <AppearanceImagePreview src={preview ? `data:${preview.mime};base64,${preview.data}` : null} name={isMixed('assetId') ? copy.mixed : asset?.name ?? copy.missingImage} dimensions={asset ? `${asset.width}×${asset.height}` : null} editLabel={copy.editImage} disabled={disabled} onEdit={onChoose} />
  </AppearanceLine>
}

// Outline -----------------------------------------------------------------------------------------------------------

const allStrokeFields: readonly (StrokeField | 'offset')[] = ['color', 'width', 'style', 'visible', 'offset']

function OutlineSection({ context }: { context: Context }) {
  const { ids, targets, disabled } = context
  const aggregate = aggregateOutline(targets.map(target => target.appearance))
  if (aggregate.state === 'absent') return <AppearanceSection id="outline" title={copy.outline} absent addLabel={copy.addOutline} onAdd={() => { commands().setOutline(ids, defaultOutline()) }} disabled={disabled} />
  const value = aggregate.value
  const mixed: readonly (StrokeField | 'offset')[] = aggregate.state === 'field-mixed' ? aggregate.mixed : aggregate.state === 'structure-mixed' ? allStrokeFields : []
  /** Field edits turn the outline on; nodes without one take the first node's outline as the base. */
  const edit = (patch: Partial<Omit<Outline, 'visible'>>) => {
    if (aggregate.state === 'uniform') commands().setOutline(ids, editStroke(value, patch))
    else commitEach(targets, appearance => withOutline(appearance, editStroke(appearance?.outline ?? value, patch)))
  }
  const setVisible = (visible: boolean) => {
    if (aggregate.state === 'uniform') commands().setOutline(ids, withStrokeVisibility(value, visible))
    else commitEach(targets, appearance => appearance?.outline ? withOutline(appearance, withStrokeVisibility(appearance.outline, visible)) : appearance)
  }
  return <AppearanceSection id="outline" title={copy.outline} disabled={disabled} {...(aggregate.state === 'uniform' ? {} : { addLabel: copy.addOutline, onAdd: () => { commands().setOutline(ids, value) } })}>
    <ColorLine id="outline" context={context} slot={{ kind: 'outline' }} value={value.color} mixed={mixed.includes('color')} labels={{ binding: copy.outlineBinding, color: copy.outlineColor, opacity: copy.outlineOpacity }} onChange={color => edit({ color })}
      trailing={<>
        <AppearanceVisibilityButton visible={value.visible !== false && !mixed.includes('visible')} showLabel={copy.showOutline} hideLabel={copy.hideOutline} disabled={disabled} onChange={setVisible} />
        <AppearanceRemoveButton label={copy.removeOutline} disabled={disabled} onClick={() => { commands().setOutline(ids, null) }} />
      </>} />
    <AppearanceLine>
      <InspectorNumberField id="outline-width" label={copy.outlineWidth} prefix={<AppearanceFieldGlyph name="stroke-width" />} value={mixed.includes('width') ? null : value.width} placeholder={copy.mixed} min={0} max={1000} disabled={disabled} onCommit={width => edit({ width })} onScrubStart={() => liveEdit(targets, (appearance, width) => withOutline(appearance, editStroke(appearance?.outline ?? value, { width })))} />
      <InspectorNumberField id="outline-offset" label={copy.outlineOffset} prefix={<AppearanceFieldGlyph name="offset" />} value={mixed.includes('offset') ? null : value.offset} placeholder={copy.mixed} min={-1000} max={1000} disabled={disabled} onCommit={offset => edit({ offset })} onScrubStart={() => liveEdit(targets, (appearance, offset) => withOutline(appearance, editStroke(appearance?.outline ?? value, { offset })))} />
      <AppearanceSelect id="outline-style" label={copy.outlineStyle} value={mixed.includes('style') ? null : value.style} placeholder={copy.mixed} options={strokeStyles} disabled={disabled} onChange={style => edit({ style: style as StrokeStyle })} />
    </AppearanceLine>
  </AppearanceSection>
}

// Border ------------------------------------------------------------------------------------------------------------

function BorderSection({ context }: { context: Context }) {
  const { ids, targets, disabled } = context
  const aggregate = aggregateBorders(targets.map(target => target.appearance))
  const add = () => { commands().addBorder(ids) }
  if (aggregate.state === 'absent') return <AppearanceSection id="border" title={copy.border} absent addLabel={copy.addBorder} onAdd={add} disabled={disabled} />
  if (aggregate.state === 'structure-mixed') return <AppearanceSection id="border" title={copy.border} addLabel={copy.addBorder} onAdd={add} disabled={disabled}>
    <AppearanceMixedButton label={copy.replaceMixedBorders} disabled={disabled} onClick={() => { commands().setBorders(ids, entriesToBorders(aggregate.value)) }} />
  </AppearanceSection>
  const entries = aggregate.value
  return <AppearanceSection id="border" title={copy.border} addLabel={copy.addBorder} onAdd={add} disabled={disabled}>
    <AppearanceList label={copy.borders}>
      {entries.map((entry, index) => <BorderRow key={entry.side} context={context} entry={entry} present={entries.map(item => item.side)} mixed={aggregate.state === 'field-mixed' ? aggregate.mixed[index] ?? [] : []} />)}
    </AppearanceList>
  </AppearanceSection>
}

const sideKeys: readonly BorderKey[] = ['all', 'top', 'bottom', 'left', 'right']

function BorderRow({ context, entry, present, mixed }: { context: Context; entry: BorderEntry; present: readonly BorderKey[]; mixed: readonly StrokeField[] }) {
  const { ids, targets, disabled } = context
  const { side, stroke } = entry
  const name = copy.sides[side]
  const uniform = !mixed.length
  const edit = (patch: Partial<Omit<Stroke, 'visible'>>) => {
    if (uniform) commands().updateBorder(ids, side, editStroke(stroke, patch))
    else commitEach(targets, appearance => withBorder(appearance, side, current => editStroke(current, patch)))
  }
  const setVisible = (visible: boolean) => {
    if (uniform) commands().updateBorder(ids, side, withStrokeVisibility(stroke, visible))
    else commitEach(targets, appearance => withBorder(appearance, side, current => withStrokeVisibility(current, visible)))
  }
  const moveTo = (next: BorderKey) => {
    if (next === side) return
    if (next === 'all') { commands().updateBorder(ids, 'all', stroke); return }
    if (side !== 'all') { commands().moveBorderSide(ids, side, next); return }
    // An "all" record becomes the chosen single side; each node keeps its own stroke.
    commitEach(targets, appearance => {
      const own = borderEntries(appearance?.borders).find(item => item.side === 'all')?.stroke
      const { borders: _borders, ...rest } = appearance ?? {}
      return own ? { ...rest, borders: { [next]: own } as Partial<Record<BorderSide, Stroke>> } : appearance
    })
  }
  const options = sideKeys.map(key => ({ value: key, label: copy.sides[key], disabled: key !== side && key !== 'all' && present.includes(key) }))
  return <AppearanceItem label={name}>
    <AppearanceLine>
      <AppearanceSelect id={`border-${side}-side`} label={copy.borderSide(name)} value={side} options={options} disabled={disabled} onChange={next => moveTo(next as BorderKey)} />
      <InspectorNumberField id={`border-${side}-width`} label={copy.borderWidth(name)} prefix={<AppearanceFieldGlyph name="stroke-width" />} value={mixed.includes('width') ? null : stroke.width} placeholder={copy.mixed} min={0} max={1000} disabled={disabled} onCommit={width => edit({ width })} onScrubStart={() => liveEdit(targets, (appearance, width) => withBorder(appearance, side, current => editStroke(current, { width })))} />
      <AppearanceSelect id={`border-${side}-style`} label={copy.borderStyle(name)} value={mixed.includes('style') ? null : stroke.style} placeholder={copy.mixed} options={strokeStyles} disabled={disabled} onChange={style => edit({ style: style as StrokeStyle })} />
      <AppearanceVisibilityButton visible={stroke.visible !== false && !mixed.includes('visible')} showLabel={copy.showBorder(name)} hideLabel={copy.hideBorder(name)} disabled={disabled} onChange={setVisible} />
      <AppearanceRemoveButton label={copy.removeBorder(name)} disabled={disabled} onClick={() => { commands().removeBorder(ids, side) }} />
    </AppearanceLine>
    <ColorLine id={`border-${side}`} context={context} slot={{ kind: 'border', side }} value={stroke.color} mixed={mixed.includes('color')} labels={{ binding: copy.borderBinding(name), color: copy.borderColor(name), opacity: copy.borderOpacity(name) }} onChange={color => edit({ color })} />
  </AppearanceItem>
}

// Sections ----------------------------------------------------------------------------------------------------------

/** Blending, Fill, Outline, and Border for every selected node, limited to the sections all of them support. */
export function AppearanceSections({ file, nodes, overrides, mode, disabled, afterFill }: { file: FileDocument; nodes: readonly StyledNode[]; overrides: Record<string, Appearance | null> | null; mode: Mode; disabled: boolean; afterFill?: ReactNode }) {
  const sections = eligibleFor(nodes)
  const targets = nodes.map(node => ({ id: node.id, node, appearance: effectiveAppearance(node, overrides) }))
  const palettes = new Map<string, SourcePalette>()
  const paletteOf = (nodeId: string) => { let palette = palettes.get(nodeId); if (!palette) { palette = documentStore.paletteFor(nodeId); palettes.set(nodeId, palette) } return palette }
  const context: Context = { file, paletteOf, mode, disabled, targets, ids: nodes.map(node => node.id) }
  return <>
    {sections.includes('blending') && <BlendingSection context={context} />}
    {sections.includes('fill') && <FillSection context={context} />}
    {afterFill}
    {sections.includes('outline') && <OutlineSection context={context} />}
    {sections.includes('border') && <BorderSection context={context} />}
  </>
}
