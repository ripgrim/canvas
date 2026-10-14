import { useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { FileDocument, PrimitiveNode } from '@canvas/repo-engine/file-document'
import { InspectorNumberField, InspectorPopover, InspectorRadioGroup, InspectorRow, InspectorSection } from '../../design-system/inspector-atoms'
import { AppearanceSelect } from '../../design-system/appearance-atoms'
import { Icon } from '../../design-system/atoms'
import { FontFamilyPicker, fontFamilyLabel, mergeFontOptions } from '../../design-system/font-family-picker'
import type { FontFamilyOption, FontStyleOption } from '../../design-system/font-family-picker'
import { SizingField } from '../../design-system/sizing-field'
import { TypographyBooleanControl, TypographyControlRow, TypographyFeatureList, TypographyFormattingControls, TypographyPreview, TypographyStatus } from '../../design-system/typography-atoms'
import { fontCatalogService } from '../fonts/font-catalog-service'
import { fontFeatureKey, fontFeatureService } from '../fonts/font-feature-service'
import { defaultFontFeatureTags, fontFeatureGroups } from '../fonts/font-feature-types'
import type { FontFeatureSnapshot } from '../fonts/font-feature-types'
import { documentStore } from './document-store'
import { localPoint, parentContentPx } from './layout-measure'
import { sceneGeometry } from './scene-geometry'
import { inspectorCopy as copy } from './inspector-copy'

type TextStyle = NonNullable<PrimitiveNode['textStyle']>
type TextSizing = NonNullable<PrimitiveNode['textSizing']>
type TextAxisSizing = TextSizing['width']
type TextAxis = keyof TextSizing
export type TextNode = PrimitiveNode & { type: 'text'; textStyle: TextStyle; textSizing: TextSizing }
type TextPropertyEntry = { nodeId: string; textStyle: TextStyle; textSizing: TextSizing }
type MaxLinesEntry = { nodeId: string; maxLines: number | undefined }
type SetPropertiesMany = (entries: readonly TextPropertyEntry[]) => boolean
type SetMaxLinesMany = (entries: readonly MaxLinesEntry[]) => boolean

const mixedValue = '__mixed__'
const same = <T,>(values: readonly T[]): T | null => {
  if (!values.length) return null
  const first = JSON.stringify(values[0])
  return values.every(value => JSON.stringify(value) === first) ? values[0]! : null
}
const clone = <T,>(value: T): T => structuredClone(value)
const textNode = (node: PrimitiveNode): node is TextNode => node.type === 'text' && Boolean(node.textStyle && node.textSizing)

export function fontOptionsFromFile(file: FileDocument): FontFamilyOption[] {
  return mergeFontOptions(Object.values(file.nodes).flatMap(node => node.type === 'text' && node.textStyle ? [{ family: node.textStyle.fontFamily, label: fontFamilyLabel(node.textStyle.fontFamily), source: 'document' as const }] : []))
}

export function closestFontStyle(current: FontStyleOption, styles: readonly FontStyleOption[] | undefined): FontStyleOption {
  if (!styles?.length) return current
  return [...styles].sort((a, b) => {
    const score = (candidate: FontStyleOption) => (candidate.style === current.style ? 0 : 1000) + Math.abs(candidate.weight - current.weight)
    return score(a) - score(b)
  })[0]!
}

export function inspectableTextNodes(nodes: readonly PrimitiveNode[]): TextNode[] {
  return nodes.every(textNode) ? [...nodes] : []
}

export function hasTextSizingReference(file: FileDocument, node: TextNode): boolean {
  const relationship = file.relationships[node.id]
  const parent = relationship ? file.nodes[relationship.parentId] : undefined
  return Boolean(parent && parent.type !== 'root')
}

/** Root text only has intrinsic or fixed axes. Fill and Relative require a real parent reference box. */
export function textSizingModes(file: FileDocument, nodes: readonly TextNode[]): TextAxisSizing['mode'][] {
  return nodes.length && nodes.every(node => hasTextSizingReference(file, node)) ? ['fixed', 'fit', 'fill', 'relative'] : ['fixed', 'fit']
}

/** Every inspector edit crosses the one complete-property command seam so no invalid intermediate text state can persist. */
export function writeTextProperties(nodes: readonly TextNode[], update: (textStyle: TextStyle, textSizing: TextSizing, node: TextNode) => void, setPropertiesMany: SetPropertiesMany = documentStore.commands.text.setPropertiesMany): number {
  const entries: TextPropertyEntry[] = []
  for (const node of nodes) {
    const textStyle = clone(node.textStyle)
    const textSizing = clone(node.textSizing)
    update(textStyle, textSizing, node)
    if (JSON.stringify(textStyle) === JSON.stringify(node.textStyle) && JSON.stringify(textSizing) === JSON.stringify(node.textSizing)) continue
    entries.push({ nodeId: node.id, textStyle, textSizing })
  }
  return entries.length && setPropertiesMany(entries) ? entries.length : 0
}

export function setTextSizingMode(nodes: readonly TextNode[], axis: TextAxis, mode: TextAxisSizing['mode'], setPropertiesMany?: SetPropertiesMany): number {
  return writeTextProperties(nodes, (style, sizing) => {
    const current = sizing[axis]
    sizing[axis] = mode === 'relative' ? { mode, value: current.mode === 'relative' ? current.value : 100 } : { mode }
    if (axis === 'height' && mode !== 'fit') delete style.maxLines
  }, setPropertiesMany)
}

export function writeTextTruncation(nodes: readonly TextNode[], enabled: boolean, setMaxLinesMany: SetMaxLinesMany = documentStore.commands.text.setMaxLinesMany): number {
  const entries = nodes.map(node => ({ nodeId: node.id, maxLines: enabled ? node.textStyle.maxLines ?? 1 : undefined }))
  return entries.length && setMaxLinesMany(entries) ? entries.length : 0
}

export function writeTextMaxLines(nodes: readonly TextNode[], value: number, setMaxLinesMany: SetMaxLinesMany = documentStore.commands.text.setMaxLinesMany): number {
  const maxLines = Math.max(1, Math.min(10000, Math.round(value)))
  const entries = nodes.map(node => ({ nodeId: node.id, maxLines }))
  return entries.length && setMaxLinesMany(entries) ? entries.length : 0
}

const horizontalOptions = [
  { value: 'left', label: copy.textAlignments.left, icon: 'text-align-left' },
  { value: 'center', label: copy.textAlignments.center, icon: 'text-align-center' },
  { value: 'right', label: copy.textAlignments.right, icon: 'text-align-right' },
] as const
const allHorizontalOptions = [...horizontalOptions, { value: 'justify', label: copy.textAlignments.justify }] as const
const verticalOptions = [
  { value: 'top', label: copy.textVerticalAlignments.top, icon: 'text-align-top' },
  { value: 'middle', label: copy.textVerticalAlignments.middle, icon: 'text-align-middle' },
  { value: 'bottom', label: copy.textVerticalAlignments.bottom, icon: 'text-align-bottom' },
] as const
const fontStyles = ['normal', 'italic', 'oblique'] as const
const fontWeights = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const
const cases = ['none', 'uppercase', 'lowercase', 'capitalize'] as const
const wraps = ['normal', 'pretty', 'balance'] as const
const sizingLabels: Record<TextAxisSizing['mode'], string> = { fixed: copy.sizingModes.fixed, fit: copy.fit, fill: copy.sizingModes.fill, relative: copy.sizingModes.relative }
const emptyFeatureSnapshot: FontFeatureSnapshot = { error: null, features: [], status: 'idle' }

export function textAxisFieldPresentation(nodes: readonly TextNode[], axis: TextAxis) {
  const mode = same(nodes.map(node => node.textSizing[axis].mode))
  const relative = mode === 'relative'
  const fixed = mode === 'fixed'
  const amount = relative
    ? same(nodes.map(node => node.textSizing[axis].mode === 'relative' ? node.textSizing[axis].value : null))
    : fixed ? same(nodes.map(node => node.styles[axis])) : null
  return { mode, relative, fixed, amount, currentLabel: mode ? sizingLabels[mode] : copy.mixed }
}

type LineHeightUnit = Exclude<TextStyle['lineHeight']['kind'], 'source'> | 'source'
const lineHeightUnit = (lineHeight: TextStyle['lineHeight']): LineHeightUnit => lineHeight.kind
const lineHeightNumber = (lineHeight: TextStyle['lineHeight']): number | null => {
  if (lineHeight.kind === 'normal') return null
  if (lineHeight.kind === 'source') return lineHeight.fallback.kind === 'normal' ? null : lineHeight.fallback.value
  return lineHeight.value
}
const lineHeightDefault = (unit: Exclude<LineHeightUnit, 'normal' | 'source'>, fontSize: number) => unit === 'percent' ? 120 : unit === 'px' ? fontSize * 1.2 : 1.2
const lineHeightSuffix = (unit: LineHeightUnit | null) => unit === 'percent' ? '%' : unit === 'px' ? 'px' : unit === 'em' ? 'em' : undefined
const fontVariantValue = (weight: number, style: TextStyle['fontStyle']) => `${weight}:${style}`
const fontVariantLabel = (weight: number, style: TextStyle['fontStyle']) => {
  const weightLabel = copy.fontWeights[weight as keyof typeof copy.fontWeights]
  if (style === 'normal') return weightLabel
  if (weight === 400) return copy.fontStyles[style]
  return `${weightLabel} ${copy.fontStyles[style].toLocaleLowerCase()}`
}
const fontVariants = fontStyles.flatMap(style => fontWeights.map(weight => ({ value: fontVariantValue(weight, style), label: fontVariantLabel(weight, style) })))

function TextAxisField({ file, nodes, axis, disabled }: { file: FileDocument; nodes: readonly TextNode[]; axis: TextAxis; disabled: boolean }) {
  const geometry = useSyncExternalStore(sceneGeometry.subscribe, sceneGeometry.getSnapshot, sceneGeometry.getSnapshot)
  const presentation = textAxisFieldPresentation(nodes, axis)
  const { mode, relative, fixed, amount, currentLabel } = presentation
  const available = textSizingModes(file, nodes)
  const label = axis === 'width' ? copy.width : copy.height
  const options = available.map(value => ({ value, label: sizingLabels[value], selected: value === mode }))
  const field = <InspectorNumberField id={`text-${axis}`} label={copy.textAxisSize(label, currentLabel)} prefix={axis === 'width' ? 'W' : 'H'} value={amount} placeholder={mode ? currentLabel : copy.mixed} min={1} max={relative ? 1000 : 1000000} {...(relative ? { suffix: '%' } : {})} disabled={disabled || !relative && !fixed} onCommit={value => {
    if (relative) writeTextProperties(nodes, (_style, sizing) => { sizing[axis] = { mode: 'relative', value } })
    else if (fixed) documentStore.commands.setStylesMany(Object.fromEntries(nodes.map(node => [node.id, { [axis]: value }])))
  }} />
  return <SizingField label={copy.textAxisSizing(label)} currentLabel={currentLabel} options={options} disabled={disabled} field={field} onChoose={value => {
    const next = value as TextAxisSizing['mode']
    documentStore.commands.text.setSizingModes(nodes.map(node => {
      const measured = geometry.nodes[node.id]?.rect[axis]
      const parent = parentContentPx(file, geometry, node.id, axis)
      const local = localPoint(file, geometry, node.id)
      return {
        nodeId: node.id,
        axes: [axis === 'width' ? 'x' as const : 'y' as const],
        mode: next,
        ...(measured === undefined ? {} : { measured: axis === 'width' ? { width: measured } : { height: measured } }),
        ...(parent === undefined ? {} : { parent: axis === 'width' ? { width: parent } : { height: parent } }),
        ...(local ? { local } : {}),
      }
    }))
  }} />
}

export function writeTextFontFeature(nodes: readonly TextNode[], tag: string, enabled: boolean, setPropertiesMany?: SetPropertiesMany): number {
  return writeTextProperties(nodes, style => {
    const features = { ...style.fontFeatures }
    if (enabled === defaultFontFeatureTags.has(tag)) delete features[tag]
    else features[tag] = enabled
    if (Object.keys(features).length) style.fontFeatures = features
    else delete style.fontFeatures
  }, setPropertiesMany)
}

const effectiveFeature = (style: TextStyle, tag: string): boolean => style.fontFeatures?.[tag] ?? defaultFontFeatureTags.has(tag)
const featureSettings = (features: Readonly<Record<string, boolean>> | undefined, preview?: Readonly<{ tag: string; value: boolean }> | null): string | undefined => {
  const values = { ...features, ...(preview ? { [preview.tag]: preview.value } : {}) }
  const entries = Object.entries(values).sort(([left], [right]) => left.localeCompare(right))
  return entries.length ? entries.map(([tag, enabled]) => `'${tag}' ${enabled ? 'on' : 'off'}`).join(', ') : undefined
}

function FontFeatures({ nodes, disabled }: { nodes: readonly TextNode[]; disabled: boolean }) {
  const family = same(nodes.map(node => node.textStyle.fontFamily))
  const style = same(nodes.map(node => node.textStyle.fontStyle))
  const weight = same(nodes.map(node => node.textStyle.fontWeight))
  const key = family && style && weight !== null ? fontFeatureKey(family, style, weight) : null
  const snapshot = useSyncExternalStore(fontFeatureService.subscribe, () => key ? fontFeatureService.getSnapshot(key) : emptyFeatureSnapshot, () => emptyFeatureSnapshot)
  const [preview, setPreview] = useState<Readonly<{ tag: string; value: boolean }> | null>(null)
  const current = nodes[0]?.textStyle
  const previewFeature = preview ? snapshot.features.find(feature => feature.tag === preview.tag) : undefined
  const groups = Object.entries(fontFeatureGroups).flatMap(([label, tags]) => {
    const features = tags.flatMap(tag => {
      const feature = snapshot.features.find(candidate => candidate.tag === tag)
      if (!feature) return []
      return [{ tag, name: feature.name, value: same(nodes.map(node => effectiveFeature(node.textStyle, tag))) }]
    })
    return features.length ? [{ label, features }] : []
  })
  const previewStyle: CSSProperties | undefined = current ? {
    fontFamily: current.fontFamily,
    fontStyle: current.fontStyle,
    fontWeight: current.fontWeight,
    fontFeatureSettings: featureSettings(current.fontFeatures, preview),
  } : undefined
  const content = snapshot.status === 'loading' || snapshot.status === 'idle'
    ? copy.loadingFontFeatures
    : snapshot.status === 'error'
      ? copy.fontFeaturesFailed
      : snapshot.status === 'unavailable'
        ? copy.noFontFeatures
        : null
  return <InspectorPopover label={copy.fontFeatures} title="Features" icon="font-features" disabled={disabled || !key} wide contentClassName="typography-features-content" onOpenChange={open => {
    setPreview(null)
    if (open && family && style && weight !== null) fontCatalogService.requestFeatures(family, { style, weight })
  }}>
    <TypographyPreview label={previewFeature?.name ?? copy.fontFeatures} {...(previewStyle ? { style: previewStyle } : {})} text={previewFeature?.sample ?? 'Lorem ipsum'} />
    {content ? <TypographyStatus>{content}</TypographyStatus> : <TypographyFeatureList groups={groups} disabled={disabled} onChange={(tag, value) => writeTextFontFeature(nodes, tag, value)} onPreview={(tag, value) => setPreview(value === null ? null : { tag, value })} />}
  </InspectorPopover>
}

type FormattingPreview = Readonly<{ property: 'textAlign' | 'textTransform' | 'textWrap' | 'wordBreak' | 'WebkitLineClamp'; value: string; caption: string }>

function TextFormatting({ nodes, disabled }: { nodes: readonly TextNode[]; disabled: boolean }) {
  const horizontal = same(nodes.map(node => node.textStyle.horizontalAlign))
  const textCase = same(nodes.map(node => node.textStyle.case))
  const wrap = same(nodes.map(node => node.textStyle.wrap))
  const keepWords = same(nodes.map(node => node.textStyle.keepWords))
  const truncated = same(nodes.map(node => node.textStyle.maxLines !== undefined))
  const maxLines = same(nodes.map(node => node.textStyle.maxLines ?? null))
  const lineHeight = same(nodes.map(node => node.textStyle.lineHeight))
  const [preview, setPreview] = useState<FormattingPreview | null>(null)
  const lineUnit = lineHeight ? lineHeightUnit(lineHeight) : null
  const setStyle = (update: (style: TextStyle) => void) => { writeTextProperties(nodes, style => update(style)) }
  const lineUnits = [
    ...(lineUnit === null ? [{ value: mixedValue, label: copy.mixed, disabled: true }] : []),
    { value: 'normal', label: copy.normal },
    { value: 'unitless', label: copy.unitless },
    { value: 'percent', label: copy.percent },
    { value: 'px', label: copy.pixels },
    { value: 'em', label: copy.ems },
    ...(lineUnit === 'source' && lineHeight?.kind === 'source' ? [{ value: 'source', label: copy.sourceLineHeight(lineHeight.property) }] : []),
  ]
  const changeLineUnit = (unit: string) => {
    if (unit === mixedValue || unit === 'source') return
    setStyle(style => {
      if (unit === 'normal') style.lineHeight = { kind: 'normal' }
      else style.lineHeight = { kind: unit as 'unitless' | 'percent' | 'px' | 'em', value: lineHeightDefault(unit as 'unitless' | 'percent' | 'px' | 'em', style.fontSize) }
    })
  }
  const current = nodes[0]?.textStyle
  const previewStyle: CSSProperties = {
    fontFamily: current?.fontFamily,
    fontStyle: current?.fontStyle,
    fontWeight: current?.fontWeight,
    ...(preview?.property === 'textAlign' ? { textAlign: preview.value as CSSProperties['textAlign'], width: 190 } : {}),
    ...(preview?.property === 'textTransform' ? { textTransform: preview.value as CSSProperties['textTransform'] } : {}),
    ...(preview?.property === 'textWrap' ? { textWrap: preview.value as CSSProperties['textWrap'], width: 180 } : {}),
    ...(preview?.property === 'wordBreak' ? { wordBreak: preview.value as CSSProperties['wordBreak'], width: 100 } : {}),
    ...(preview?.property === 'WebkitLineClamp' && preview.value !== '0' ? { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: preview.value, overflow: 'hidden', width: 190 } : {}),
  }
  const sample = preview?.property === 'textWrap' ? 'The quick brown fox jumps over the lazy dog.' : preview?.property === 'wordBreak' ? '완벽한 타이포그래피' : preview ? 'Perfect typography\nis certainly the most\nelusive of all arts.' : 'Lorem ipsum'
  const alignmentPreview = (value: TextStyle['horizontalAlign'] | null) => setPreview(value ? { property: 'textAlign', value, caption: `Align ${value}` } : null)
  const casePreview = (value: TextStyle['case'] | null) => setPreview(value ? { property: 'textTransform', value: value === 'none' ? 'none' : value, caption: copy.textCases[value] } : null)
  return <InspectorPopover label={copy.textFormatting} title="Formatting" icon="text-settings" disabled={disabled} wide contentClassName="typography-formatting-content" onOpenChange={() => setPreview(null)}>
    <TypographyPreview label={preview?.caption ?? copy.textFormatting} {...(preview?.caption ? { caption: preview.caption } : {})} style={previewStyle} text={sample} />
    <TypographyFormattingControls>
      <TypographyControlRow label={copy.textAlignment}><InspectorRadioGroup label={copy.textAlignment} value={horizontal} options={allHorizontalOptions} mixedLabel={copy.mixed} onPreview={alignmentPreview} onChange={value => setStyle(style => { style.horizontalAlign = value })} disabled={disabled} /></TypographyControlRow>
      <TypographyControlRow label={copy.textCase}><InspectorRadioGroup label={copy.textCase} value={textCase} options={cases.map(value => ({ value, label: value === 'none' ? '／' : value === 'uppercase' ? 'AA' : value === 'lowercase' ? 'aa' : 'Aa' }))} mixedLabel={copy.mixed} showLabels onPreview={casePreview} onChange={value => setStyle(style => { style.case = value })} disabled={disabled} /></TypographyControlRow>
      <TypographyControlRow label={copy.textWrap}><AppearanceSelect id="text-wrap" label={copy.textWrap} value={wrap} placeholder={copy.mixed} options={wraps.map(value => ({ value, label: copy.textWraps[value] }))} align="start" layer="popover" placement="bottom" disabled={disabled} onChange={value => setStyle(style => { style.wrap = value as TextStyle['wrap'] })} /></TypographyControlRow>
      <TypographyControlRow label={copy.keepWords}><TypographyBooleanControl label={copy.keepWords} value={keepWords} disabled={disabled} onPreview={value => setPreview(value === null ? null : { property: 'wordBreak', value: value ? 'keep-all' : 'normal', caption: value ? 'Keep words' : 'Split words' })} onChange={value => setStyle(style => { style.keepWords = value })} /></TypographyControlRow>
      <TypographyControlRow label={copy.truncation}><TypographyBooleanControl label={copy.truncation} value={truncated} disabled={disabled} onPreview={value => setPreview(value === null ? null : { property: 'WebkitLineClamp', value: value ? String(maxLines ?? 1) : '0', caption: value ? 'Truncate' : 'No truncation' })} onChange={value => writeTextTruncation(nodes, value)} /></TypographyControlRow>
      {truncated !== false && <TypographyControlRow label={copy.maxLines}><InspectorNumberField id="text-max-lines" label={copy.maxLines} value={maxLines} placeholder={copy.mixed} min={1} max={10000} disabled={disabled} onCommit={value => writeTextMaxLines(nodes, value)} /></TypographyControlRow>}
      <TypographyControlRow label={copy.lineHeightUnit}><AppearanceSelect id="text-line-height-unit" label={copy.lineHeightUnit} value={lineUnit ?? mixedValue} options={lineUnits} align="start" layer="popover" placement="bottom" disabled={disabled} onChange={changeLineUnit} /></TypographyControlRow>
    </TypographyFormattingControls>
  </InspectorPopover>
}

export function TextInspector({ file, nodes, disabled }: { file: FileDocument; nodes: readonly TextNode[]; disabled: boolean }) {
  const family = same(nodes.map(node => node.textStyle.fontFamily))
  const fontVariant = same(nodes.map(node => fontVariantValue(node.textStyle.fontWeight, node.textStyle.fontStyle)))
  const fontSize = same(nodes.map(node => node.textStyle.fontSize))
  const lineHeight = same(nodes.map(node => node.textStyle.lineHeight))
  const lineUnit = lineHeight ? lineHeightUnit(lineHeight) : null
  const letterSpacing = same(nodes.map(node => node.textStyle.letterSpacing))
  const horizontal = same(nodes.map(node => node.textStyle.horizontalAlign))
  const vertical = same(nodes.map(node => node.textStyle.verticalAlign))
  const setStyle = (update: (style: TextStyle) => void) => { writeTextProperties(nodes, style => update(style)) }
  return <InspectorSection id="text" title={copy.text} actions={<><FontFeatures nodes={nodes} disabled={disabled} /><TextFormatting nodes={nodes} disabled={disabled} /></>}>
    <FontFamilyPicker id="text-family" value={family} placeholder={copy.mixed} options={fontOptionsFromFile(file)} disabled={disabled} copy={copy.fontPicker} onChoose={option => {
      const requested = closestFontStyle({ style: nodes[0]?.textStyle.fontStyle ?? 'normal', weight: nodes[0]?.textStyle.fontWeight ?? 400 }, option.styles)
      writeTextProperties(nodes, style => {
        const match = closestFontStyle({ style: style.fontStyle, weight: style.fontWeight }, option.styles)
        style.fontFamily = option.family
        style.fontStyle = match.style as TextStyle['fontStyle']
        style.fontWeight = match.weight
      })
      return requested
    }} />
    <AppearanceSelect id="text-variant" label={copy.fontStyle} prefix={<Icon name="font-style" />} value={fontVariant} placeholder={copy.mixed} options={fontVariants} align="start" placement="bottom" disabled={disabled} onChange={value => {
      if (value === mixedValue) return
      const [weight, style] = value.split(':')
      setStyle(text => { text.fontWeight = Number(weight); text.fontStyle = style as TextStyle['fontStyle'] })
    }} />
    <InspectorRow>
      <InspectorNumberField id="text-size" label={copy.fontSize} prefix={<Icon name="font-size" />} value={fontSize} placeholder={copy.mixed} min={1} max={10000} disabled={disabled} onCommit={value => setStyle(style => { style.fontSize = value })} />
      <InspectorNumberField id="text-line-height" label={lineUnit === 'source' && lineHeight?.kind === 'source' ? copy.sourceLineHeight(lineHeight.property) : copy.lineHeight} prefix={<Icon name="line-height" />} value={lineHeight ? lineHeightNumber(lineHeight) : null} placeholder={lineUnit === 'normal' ? copy.normal : lineUnit === 'source' ? copy.source : copy.mixed} min={0.01} max={10000} {...(lineHeightSuffix(lineUnit) ? { suffix: lineHeightSuffix(lineUnit)! } : {})} disabled={disabled || lineUnit === 'normal' || lineUnit === 'source' || lineUnit === null} onCommit={value => setStyle(style => { if (style.lineHeight.kind !== 'normal' && style.lineHeight.kind !== 'source') style.lineHeight = { kind: style.lineHeight.kind, value } })} />
      <InspectorNumberField id="text-letter-spacing" label={copy.letterSpacing} prefix={<Icon name="letter-spacing" />} value={letterSpacing} placeholder={copy.mixed} min={-1000} max={1000} suffix="%" disabled={disabled} onCommit={value => setStyle(style => { style.letterSpacing = value })} />
    </InspectorRow>
    <InspectorRow>
      <InspectorRadioGroup label={copy.textHorizontalAlignment} value={horizontal === 'justify' ? null : horizontal} options={horizontalOptions} mixedLabel={horizontal === 'justify' ? copy.justifiedInFormatting : copy.mixed} onChange={value => setStyle(style => { style.horizontalAlign = value })} disabled={disabled} />
      <InspectorRadioGroup label={copy.textVerticalAlignment} value={vertical} options={verticalOptions} mixedLabel={copy.mixed} onChange={value => setStyle(style => { style.verticalAlign = value })} disabled={disabled} />
    </InspectorRow>
    <InspectorRow>
      <TextAxisField file={file} nodes={nodes} axis="width" disabled={disabled} />
      <TextAxisField file={file} nodes={nodes} axis="height" disabled={disabled} />
    </InspectorRow>
  </InspectorSection>
}
