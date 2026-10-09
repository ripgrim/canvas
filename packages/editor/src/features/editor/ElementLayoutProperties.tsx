import { useSyncExternalStore } from 'react'
import { PropertyField, PropertyGrid, PropertyGroup, PropertyHint, PropertySelect } from '../../design-system/property-atoms'
import { legacyLayout } from '@canvas/repo-engine/layout'
import { documentStore } from './document-store'
import { propertiesCopy as copy } from './properties-copy'

const numeric = (value: string, minimum = -1000000) => {
  const next = Number(value)
  return Number.isFinite(next) && next >= minimum && next <= 1000000 ? Math.round(next) : null
}

export function ElementLayoutProperties() {
  const state = useSyncExternalStore(documentStore.subscribe, documentStore.getViewSnapshot, documentStore.getViewSnapshot)
  if (!state.file || state.selection.length !== 1) return null
  const id = state.selection[0]!
  const node = state.file.nodes[id]
  if (!node || node.type === 'root') return null
  if (node.type !== 'component') {
    const styles = node.styles
    return <PropertyGroup title={copy.layout}><PropertyHint>{copy.absoluteCanvas}</PropertyHint><PropertyGrid>
      <PropertyField id={`${id}-x`} label={copy.x} type="number" value={String(styles.left)} disabled={state.blocked} onChange={value => { const next = numeric(value); if (next !== null) documentStore.commands.setStyles(id, { left: next }) }} />
      <PropertyField id={`${id}-y`} label={copy.y} type="number" value={String(styles.top)} disabled={state.blocked} onChange={value => { const next = numeric(value); if (next !== null) documentStore.commands.setStyles(id, { top: next }) }} />
      <PropertyField id={`${id}-width`} label={copy.width} type="number" value={String(styles.width)} disabled={state.blocked} onChange={value => { const next = numeric(value, 1); if (next !== null) documentStore.commands.setStyles(id, { width: next }) }} />
      <PropertyField id={`${id}-height`} label={copy.height} type="number" value={String(styles.height)} disabled={state.blocked} onChange={value => { const next = numeric(value, 1); if (next !== null) documentStore.commands.setStyles(id, { height: next }) }} />
    </PropertyGrid></PropertyGroup>
  }
  const layout = legacyLayout(node.layout)
  return <PropertyGroup title={copy.layout}><PropertySelect id={`${id}-layout-mode`} label={copy.position} value={layout.mode} options={[{ value: 'flow', label: copy.flow }, { value: 'absolute', label: copy.absolute }]} disabled={state.blocked} onChange={mode => documentStore.commands.setLayout(id, { ...layout, mode: mode as 'flow' | 'absolute' })} /><PropertyHint>{layout.mode === 'flow' ? copy.flowHint : copy.absoluteHint}</PropertyHint><PropertyGrid>
    <PropertyField id={`${id}-x`} label={copy.x} type="number" value={String(layout.x)} disabled={state.blocked || layout.mode === 'flow'} onChange={value => { const next = numeric(value); if (next !== null) documentStore.commands.setLayout(id, { ...layout, x: next }) }} />
    <PropertyField id={`${id}-y`} label={copy.y} type="number" value={String(layout.y)} disabled={state.blocked || layout.mode === 'flow'} onChange={value => { const next = numeric(value); if (next !== null) documentStore.commands.setLayout(id, { ...layout, y: next }) }} />
    <PropertyField id={`${id}-width`} label={copy.width} type="number" value={layout.width === undefined ? '' : String(layout.width)} disabled={state.blocked} onChange={value => { const next = numeric(value, 1); if (next !== null) documentStore.commands.setLayout(id, { ...layout, width: next }) }} />
    <PropertyField id={`${id}-height`} label={copy.height} type="number" value={layout.height === undefined ? '' : String(layout.height)} disabled={state.blocked} onChange={value => { const next = numeric(value, 1); if (next !== null) documentStore.commands.setLayout(id, { ...layout, height: next }) }} />
  </PropertyGrid></PropertyGroup>
}
