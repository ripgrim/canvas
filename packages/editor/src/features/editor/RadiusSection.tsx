import { useState } from 'react'
import { appearanceLimits, canonicalAppearance, cornerRadiusKeys, expandedCornerRadii, supportsCornerRadii } from '@canvas/repo-engine/appearance'
import type { Appearance, CornerRadii, CornerRadiusKey } from '@canvas/repo-engine/appearance'
import { AppearanceSection } from '../../design-system/appearance-atoms'
import type { DragSession } from '../../design-system/appearance-atoms'
import { InspectorScrubField } from '../../design-system/inspector-atoms'
import { RadiusCornerGlyph, RadiusCornerGrid, RadiusModeButton, RadiusSlider, RadiusUnifiedRow } from '../../design-system/radius-atoms'
import { effectiveAppearance, overridesFor } from './appearance-adapters'
import type { StyledNode } from './appearance-adapters'
import { documentStore } from './document-store'

const radiusCopy = {
  title: 'Radius',
  mixed: 'Mixed',
  all: 'Corner radius',
  toggle: 'Show individual corners',
  toggleUnified: 'Show one radius',
  corners: { topLeft: 'Top-left radius', topRight: 'Top-right radius', bottomLeft: 'Bottom-left radius', bottomRight: 'Bottom-right radius' },
} as const

type Target = { id: string; appearance: Appearance | undefined }
type Agreement = { mixed: boolean; value: number | null }

const sameNumber = (values: readonly number[]): Agreement => ({ mixed: values.some(value => value !== values[0]), value: values.every(value => value === values[0]) ? values[0] ?? null : null })

/** A shared field agreement over effective appearances, including live gesture overrides. */
export function cornerRadiusAgreement(appearances: readonly (Appearance | undefined)[], corner?: CornerRadiusKey): Agreement {
  if (!appearances.length) return { mixed: false, value: null }
  const expanded = appearances.map(appearance => expandedCornerRadii(appearance?.cornerRadii))
  if (corner) return sameNumber(expanded.map(value => value[corner]))
  return sameNumber(expanded.flatMap(value => cornerRadiusKeys.map(key => value[key])))
}

/** Replaces the radius field without disturbing any other appearance section. */
export function withCornerRadii(appearance: Appearance | undefined, cornerRadii: CornerRadii): Appearance | undefined {
  return canonicalAppearance({ ...(appearance ?? {}), cornerRadii })
}

function commitEach(targets: readonly Target[], update: (appearance: Appearance | undefined) => Appearance | undefined): boolean {
  const gesture = documentStore.commands.appearance.gesture
  gesture.begin()
  gesture.preview(overridesFor(targets, appearance => update(appearance)))
  return gesture.commit()
}

function liveEdit(targets: readonly Target[], update: (appearance: Appearance | undefined, value: number) => Appearance | undefined): DragSession<number> {
  const gesture = documentStore.commands.appearance.gesture
  gesture.begin()
  return {
    move: value => gesture.preview(overridesFor(targets, appearance => update(appearance, value))),
    end: () => { gesture.commit() },
    cancel: () => gesture.cancel(),
  }
}

function RadiusSectionBody({ nodes, overrides, disabled }: { nodes: readonly StyledNode[]; overrides: Record<string, Appearance | null> | null; disabled: boolean }) {
  const targets = nodes.map(node => ({ id: node.id, appearance: effectiveAppearance(node, overrides) }))
  const authoredIndividual = targets.some(target => target.appearance?.cornerRadii && !('all' in target.appearance.cornerRadii))
  const [individual, setIndividual] = useState(authoredIndividual)
  const appearances = targets.map(target => target.appearance)
  const uniform = cornerRadiusAgreement(appearances)
  const cornerValues = Object.fromEntries(cornerRadiusKeys.map(corner => [corner, cornerRadiusAgreement(appearances, corner)])) as Record<CornerRadiusKey, Agreement>
  const sliderMax = Math.max(100, uniform.value ?? 0, ...Object.values(cornerValues).map(value => value.value ?? 0))
  const setAll = (value: number) => commitEach(targets, appearance => withCornerRadii(appearance, { all: value }))
  const scrubAll = () => liveEdit(targets, (appearance, value) => withCornerRadii(appearance, { all: value }))
  const setCorner = (corner: CornerRadiusKey, value: number) => commitEach(targets, appearance => withCornerRadii(appearance, { ...expandedCornerRadii(appearance?.cornerRadii), [corner]: value }))
  const scrubCorner = (corner: CornerRadiusKey) => liveEdit(targets, (appearance, value) => withCornerRadii(appearance, { ...expandedCornerRadii(appearance?.cornerRadii), [corner]: value }))
  const actionLabel = individual ? radiusCopy.toggleUnified : radiusCopy.toggle
  return <AppearanceSection id="radius" title={radiusCopy.title} disabled={disabled} actions={<RadiusModeButton individual={individual} label={actionLabel} disabled={disabled} onChange={setIndividual} />}>
    {individual
      ? <RadiusCornerGrid>{cornerRadiusKeys.map(corner => <InspectorScrubField key={corner} id={`radius-${corner}`} label={radiusCopy.corners[corner]} prefix={<RadiusCornerGlyph corner={corner} />} value={cornerValues[corner].value} placeholder={radiusCopy.mixed} min={0} max={appearanceLimits.radius} disabled={disabled} onCommit={value => setCorner(corner, value)} onScrubStart={() => scrubCorner(corner)} />)}</RadiusCornerGrid>
      : <RadiusUnifiedRow slider={<RadiusSlider label={radiusCopy.all} mixedText={radiusCopy.mixed} value={uniform.value} max={sliderMax} disabled={disabled} onCommit={setAll} onScrubStart={scrubAll} />} field={<InspectorScrubField id="radius-all" label={radiusCopy.all} value={uniform.value} placeholder={radiusCopy.mixed} min={0} max={appearanceLimits.radius} disabled={disabled} onCommit={setAll} onScrubStart={scrubAll} />} />}
  </AppearanceSection>
}

/** Paper-like radius section for selections whose roots can safely own CSS border radius. */
export function RadiusSection({ nodes, overrides, disabled }: { nodes: readonly StyledNode[]; overrides: Record<string, Appearance | null> | null; disabled: boolean }) {
  if (!nodes.length || !nodes.every(node => supportsCornerRadii(node.type))) return null
  return <RadiusSectionBody key={nodes.map(node => node.id).join(' ')} nodes={nodes} overrides={overrides} disabled={disabled} />
}
