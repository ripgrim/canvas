import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { resolveComponentInstanceValues } from '@canvas/repo-engine/component-model'
import { childrenOf } from '@canvas/repo-engine/file-document'
import { ComponentPropertyTypeMenu, ComponentPropertyValueRow } from '../../design-system/component-kit-atoms'
import { Button, Icon, ScopePicker } from '../../design-system/atoms'
import { PropertyField, PropertyGroup, PropertySelect, PropertyToggle, PropertyValue } from '../../design-system/property-atoms'
import { documentStore } from './document-store'
import { componentKitCopy } from './component-kit-copy'
import { propertiesCopy as copy } from './properties-copy'
import { canNestComponentInstance, mapParallelComponentSubtrees } from './component-canvas-link'
import { componentConfigurableDefinition } from './component-property-projection'

export function ComponentModelProperties() {
  const { file, selection, atoms, blocked } = useSyncExternalStore(documentStore.subscribe, documentStore.getViewSnapshot, documentStore.getViewSnapshot)
  if (!file || selection.length !== 1) return null
  const instance = file.componentModel.instances[selection[0]!]
  const definition = instance ? file.componentModel.definitions[instance.componentId] : undefined
  if (!instance || !definition) return null
  const values = resolveComponentInstanceValues(definition, instance.values)
  const instanceProperties = componentConfigurableDefinition(definition).properties
  const atom = definition.source.kind === 'code' ? atoms.find(candidate => candidate.componentId === definition.id) : undefined
  const node = definition.source.kind === 'code' ? file.nodes[instance.id] : undefined
  const modeledNames = new Set(definition.properties.map(property => property.name))
  const sourceValues = node?.type === 'component' ? Object.entries(node.props).filter(([name]) => !modeledNames.has(name)) : []
  const hasResettableValues = instanceProperties.some(property => Object.hasOwn(instance.values, property.id))
  const nodeMap = definition.source.kind === 'canvas' ? mapParallelComponentSubtrees(file, definition.source.masterRootId, instance.id) : null
  const scopes = definition.source.kind === 'canvas' ? [copy.instanceScope, copy.sharedComponentScope] as const : [copy.instanceScope] as const
  const valueRow = (propertyId: string, propertyName: string, description: string | undefined, control: ReactNode) => {
    const overridden = Object.hasOwn(instance.values, propertyId)
    const reset = overridden ? <Button label={componentKitCopy.resetProperty(propertyName)} variant="ghost" disabled={blocked} onClick={() => documentStore.commands.components.setInstanceValue(instance.id, propertyId, null)}><Icon name="refresh" /></Button> : undefined
    return <ComponentPropertyValueRow key={propertyId} {...(description ? { description } : {})} action={reset}>{control}</ComponentPropertyValueRow>
  }
  const instanceActions = <>
    {definition.source.kind === 'canvas' && <Button label={componentKitCopy.openMainComponent} variant="ghost" disabled={blocked} onClick={() => documentStore.commands.components.openMaster(definition.id)}><Icon name="target" /></Button>}
    {hasResettableValues && <Button label={componentKitCopy.resetInstance} variant="ghost" disabled={blocked} onClick={() => documentStore.commands.components.resetInstanceValues(instance.id)}><Icon name="refresh" /></Button>}
    {definition.source.kind === 'canvas' && <Button label={componentKitCopy.detachInstance} variant="ghost" disabled={blocked} onClick={() => documentStore.commands.components.detach(instance.id)}><Icon name="unlink" /></Button>}
  </>
  return <>
    {(instanceProperties.length > 0 || definition.source.kind === 'canvas') && <PropertyGroup title={copy.properties} action={instanceActions}>{instanceProperties.length > 0 && <ScopePicker label={copy.editScope} value={copy.instanceScope} values={scopes} disabled={blocked} onChange={scope => { if (scope === copy.sharedComponentScope) documentStore.commands.components.openMaster(definition.id) }} />}{instanceProperties.map(property => {
      const id = `model-${instance.id}-${property.id}`
      const value = values[property.id]
      const overridden = Object.hasOwn(instance.values, property.id)
      if (property.type === 'variant') return valueRow(property.id, property.name, property.description, <PropertySelect id={id} label={property.name} value={property.optional && !overridden ? '' : String(value)} options={[...(property.optional ? [{ value: '', label: componentKitCopy.componentDefault }] : []), ...property.values.map(option => ({ value: option.id, label: option.name }))]} disabled={blocked} onChange={next => documentStore.commands.components.setInstanceValue(instance.id, property.id, next === '' || !property.optional && next === property.defaultValueId ? null : next)} />)
      if (property.type === 'text') return valueRow(property.id, property.name, property.description, <PropertyField id={id} label={property.name} value={property.optional && !overridden ? '' : String(value)} {...(property.optional && !overridden ? { mixed: componentKitCopy.componentDefault } : {})} disabled={blocked} onChange={next => documentStore.commands.components.setInstanceValue(instance.id, property.id, !property.optional && next === property.defaultValue ? null : next)} />)
      if (property.type === 'boolean' && property.optional) return valueRow(property.id, property.name, property.description, <PropertySelect id={id} label={property.name} value={overridden ? String(value) : ''} options={[{ value: '', label: componentKitCopy.componentDefault }, { value: 'true', label: componentKitCopy.on }, { value: 'false', label: componentKitCopy.off }]} disabled={blocked} onChange={next => documentStore.commands.components.setInstanceValue(instance.id, property.id, next === '' ? null : next === 'true')} />)
      if (property.type === 'boolean') return valueRow(property.id, property.name, property.description, <PropertyToggle id={id} label={property.name} checked={Boolean(value)} disabled={blocked} onChange={next => documentStore.commands.components.setInstanceValue(instance.id, property.id, next === property.defaultValue ? null : next)} />)
      const slotHost = definition.source.kind === 'canvas' ? property.binding ? nodeMap?.get(property.binding.nodeId) : undefined : instance.id
      const slotName = definition.source.kind === 'code' ? property.name : property.id
      const count = slotHost ? childrenOf(file, slotHost, slotName).length : 0
      const components = Object.values(file.componentModel.definitions).filter(candidate => canNestComponentInstance(file, instance.id, candidate.id) && (candidate.source.kind === 'canvas' || atoms.some(atom => atom.componentId === candidate.id && atom.status === 'bound')))
      const options = [...componentKitCopy.slotOptions, ...components.map(candidate => ({ value: `component:${candidate.id}`, label: candidate.name, icon: 'component' as const, group: componentKitCopy.slotComponents }))]
      return <ComponentPropertyValueRow key={property.id} {...(property.description ? { description: property.description } : {})} action={<ComponentPropertyTypeMenu label={componentKitCopy.addSlotContent(property.name)} disabled={blocked || !slotHost} options={options} onSelect={kind => kind.startsWith('component:') ? documentStore.commands.components.addSlotComponent(instance.id, property.id, kind.slice('component:'.length)) : documentStore.commands.components.addSlotContent(instance.id, property.id, kind as 'text' | 'frame')} />}><PropertyValue label={property.name} value={copy.slotCount(count)} /></ComponentPropertyValueRow>
    })}</PropertyGroup>}
    {definition.source.kind === 'code' && atom && <PropertyGroup title={copy.source}>{sourceValues.map(([name, value]) => <PropertyValue key={name} label={name} value={String(value)} />)}<PropertyValue label={copy.sourcePath} value={atom.path} /><PropertyValue label={copy.sourceExport} value={atom.exportName} /></PropertyGroup>}
  </>
}
