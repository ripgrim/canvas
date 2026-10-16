import { useState } from 'react'
import type { Appearance } from '@canvas/repo-engine/appearance'
import { componentDescriptionLimit } from '@canvas/repo-engine/component-model'
import type { ComponentDefinition, ComponentInstanceRecord, ComponentInteraction, ComponentMaterial, ComponentPart, ComponentPropertyDefinition } from '@canvas/repo-engine/component-model'
import type { FileCommand } from '@canvas/repo-engine/file-document'
import { nodeAppearance } from '@canvas/repo-engine/file-document'
import { Button, Icon } from '../../design-system/atoms'
import type { IconName } from '../../design-system/atoms'
import { ComponentAuthoringDialog, ComponentAuthoringError, ComponentAuthoringSection, ComponentOptionList, ComponentOptionRow } from '../../design-system/component-kit-atoms'
import { PropertyField, PropertySelect, PropertyToggle, PropertyValue } from '../../design-system/property-atoms'
import { documentStore } from './document-store'
import { componentPropertyProjectionCommands, componentPropertyRebindingResetCommands, componentSlotRebindingCommands } from './component-property-projection'
import { componentMaterialProjectionCommands } from './component-material-projection'
import { componentKitCopy as copy } from './component-kit-copy'

export type ComponentNodeChoice = Readonly<{ id: string; name: string; type: string; icon: IconName; componentId?: string }>

export function componentPropertyBindingNodes(nodes: readonly ComponentNodeChoice[], type: ComponentPropertyDefinition['type'], unavailableNodeIds: readonly string[] = []): readonly ComponentNodeChoice[] {
  const available = nodes.filter(node => !unavailableNodeIds.includes(node.id))
  if (type === 'text') return available.filter(node => node.type === 'text')
  if (type === 'slot') return available.filter(node => node.type === 'frame')
  if (type === 'instance-swap') return available.filter(node => Boolean(node.componentId))
  return available
}

type InteractionDraft = Readonly<{
  valueId: string
  type: 'instant' | 'smart-animate'
  duration: string
  easing: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'
}>

type VariantOptionDraft = Readonly<{ id: string; name: string }>

type PropertyDraft = Readonly<{
  name: string
  description: string
  nodeId: string
  defaultText: string
  defaultBoolean: boolean
  defaultComponentId: string
  options: readonly VariantOptionDraft[]
  defaultValueId: string
  currentValueId: string
  hover: InteractionDraft
  press: InteractionDraft
}>

const emptyInteraction = (): InteractionDraft => ({ valueId: '', type: 'smart-animate', duration: '300', easing: 'ease-out' })

export function uniqueComponentDraftName(names: readonly string[], base: string): string {
  const used = (candidate: string) => names.some(name => name.localeCompare(candidate, undefined, { sensitivity: 'accent' }) === 0)
  if (!used(base)) return base
  let suffix = 2
  while (used(`${base} ${suffix}`)) suffix += 1
  return `${base} ${suffix}`
}

function interactionDraft(interaction: ComponentInteraction | undefined): InteractionDraft {
  return interaction ? {
    valueId: interaction.valueId,
    type: interaction.transition?.type ?? 'smart-animate',
    duration: String(interaction.transition?.durationMs ?? 300),
    easing: interaction.transition?.easing ?? 'ease-out',
  } : emptyInteraction()
}

function initialPropertyDraft(property: ComponentPropertyDefinition | undefined, type: ComponentPropertyDefinition['type'], interactions: readonly ComponentInteraction[], defaultNodeId: string, defaultComponentId: string, defaultName: string, defaultText: string, defaultBoolean: boolean): PropertyDraft {
  const initialOption = { id: crypto.randomUUID(), name: 'Default' }
  const variant = property?.type === 'variant' ? property : undefined
  return {
    name: property?.name ?? defaultName,
    description: property?.description ?? '',
    nodeId: property?.binding?.nodeId ?? defaultNodeId,
    defaultText: property?.type === 'text' ? property.defaultValue : defaultText,
    defaultBoolean: property?.type === 'boolean' ? property.defaultValue : defaultBoolean,
    defaultComponentId: property?.type === 'instance-swap' ? property.defaultValue : defaultComponentId,
    options: variant?.values ?? [initialOption],
    defaultValueId: variant?.defaultValueId ?? initialOption.id,
    currentValueId: variant?.currentValueId ?? variant?.defaultValueId ?? initialOption.id,
    hover: interactionDraft(interactions.find(interaction => interaction.trigger === 'pointer-hover' && interaction.propertyId === property?.id)),
    press: interactionDraft(interactions.find(interaction => interaction.trigger === 'pointer-press' && interaction.propertyId === property?.id)),
  }
}

export function propertyDraftError(draft: Pick<PropertyDraft, 'name' | 'options'>, type: ComponentPropertyDefinition['type'], siblingNames: readonly string[]): string | null {
  if (!draft.name.trim()) return copy.propertyName
  if (siblingNames.some(name => name.localeCompare(draft.name.trim(), undefined, { sensitivity: 'accent' }) === 0)) return copy.nameExists
  if (type !== 'variant') return null
  const names = draft.options.map(option => option.name.trim().toLocaleLowerCase())
  return draft.options.length === 0 || names.some(name => !name) || new Set(names).size !== names.length ? copy.optionNamesRequired : null
}

function withBinding(property: ComponentPropertyDefinition, nodeId: string): ComponentPropertyDefinition {
  const snapshot = documentStore.getSnapshot()
  const node = snapshot.file?.nodes[nodeId]
  if (!nodeId || !node || node.type === 'root') {
    const { binding: _binding, ...unbound } = property
    return unbound as ComponentPropertyDefinition
  }
  if (property.type === 'variant') {
    const fallback = structuredClone(nodeAppearance(node) ?? {})
    const previous = property.binding?.nodeId === nodeId ? property.binding.appearances : {}
    return { ...property, binding: { kind: 'variant', nodeId, appearances: Object.fromEntries(property.values.map(option => [option.id, structuredClone(previous[option.id] ?? fallback)])) } }
  }
  if (property.type === 'text') return { ...property, binding: { kind: 'text', nodeId } }
  if (property.type === 'boolean') return { ...property, binding: { kind: 'visibility', nodeId } }
  if (property.type === 'instance-swap') return { ...property, binding: { kind: 'instance-swap', nodeId } }
  return { ...property, binding: { kind: 'slot', nodeId } }
}

function withPropertyDescription(property: ComponentPropertyDefinition, value: string): ComponentPropertyDefinition {
  const { description: _description, ...withoutDescription } = property
  const description = value.trim()
  return description ? { ...withoutDescription, description } as ComponentPropertyDefinition : withoutDescription as ComponentPropertyDefinition
}

function authoredInteraction(propertyId: string, trigger: ComponentInteraction['trigger'], draft: InteractionDraft, existing: ComponentInteraction | undefined): ComponentInteraction | null {
  if (!draft.valueId) return null
  const durationMs = Number(draft.duration)
  return {
    id: existing?.id ?? crypto.randomUUID(),
    trigger,
    propertyId,
    valueId: draft.valueId,
    transition: draft.type === 'instant'
      ? { type: 'instant' }
      : { type: 'smart-animate', durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.min(60_000, durationMs)) : 300, easing: draft.easing },
  }
}

function replaceAuthoredProperty(componentId: string, property: ComponentPropertyDefinition, hover: InteractionDraft, press: InteractionDraft): boolean {
  const file = documentStore.getSnapshot().file
  const definition = file?.componentModel.definitions[componentId]
  if (!file || !definition) return false
  const exists = definition.properties.some(candidate => candidate.id === property.id)
  if (exists && property.type === 'instance-swap') return documentStore.commands.components.setProperty(componentId, property)
  const properties = exists ? definition.properties.map(candidate => candidate.id === property.id ? property : candidate) : [...definition.properties, property]
  const retained = definition.interactions.filter(interaction => interaction.propertyId !== property.id)
  const previous = definition.interactions.filter(interaction => interaction.propertyId === property.id)
  const authored = property.type === 'variant' ? [
    authoredInteraction(property.id, 'pointer-hover', hover, previous.find(interaction => interaction.trigger === 'pointer-hover')),
    authoredInteraction(property.id, 'pointer-press', press, previous.find(interaction => interaction.trigger === 'pointer-press')),
  ].filter((interaction): interaction is ComponentInteraction => interaction !== null) : []
  const nextDefinition: ComponentDefinition = { ...definition, revision: definition.revision + 1, properties, interactions: [...retained, ...authored] }
  const commands: FileCommand[] = [
    ...componentPropertyRebindingResetCommands(file, definition, property),
    ...componentSlotRebindingCommands(file, definition, property),
  ]
  const instances: ComponentInstanceRecord[] = []
  for (const instance of Object.values(file.componentModel.instances)) {
    if (instance.componentId !== componentId) continue
    const values = { ...instance.values }
    const override = values[property.id]
    if (property.type === 'variant' && typeof override === 'string' && !property.values.some(option => option.id === override)) delete values[property.id]
    const nextInstance = { ...instance, values }
    instances.push(nextInstance)
    if (JSON.stringify(values) !== JSON.stringify(instance.values)) commands.push({ type: 'component.instance.replace', instanceId: instance.id, expected: instance, instance: nextInstance })
  }
  commands.push({ type: 'component.replace', componentId, expectedRevision: definition.revision, definition: nextDefinition })
  if (definition.source.kind === 'canvas' && property.binding) {
    if (property.type === 'text') commands.push({ type: 'node.setText', nodeId: property.binding.nodeId, text: property.defaultValue })
    if (property.type === 'boolean') commands.push({ type: 'node.setBlending', nodeId: property.binding.nodeId, visible: property.defaultValue })
    if (property.type === 'variant') {
      const valueId = property.currentValueId ?? property.defaultValueId
      const appearance = property.binding.appearances[valueId]
      if (appearance) commands.push({ type: 'node.setAppearance', nodeId: property.binding.nodeId, appearance: structuredClone(appearance) })
    }
  }
  for (const instance of instances) commands.push(...componentPropertyProjectionCommands(file, nextDefinition, instance, [property]))
  return documentStore.commands.executeBatch(commands)
}

function InteractionFields({ id, label, value, options, disabled, onChange }: { id: string; label: string; value: InteractionDraft; options: readonly VariantOptionDraft[]; disabled: boolean; onChange: (next: InteractionDraft) => void }) {
  return <>
    <PropertySelect id={`${id}-value`} label={label} value={value.valueId} options={[{ value: '', label: copy.interactionNone }, ...options.map(option => ({ value: option.id, label: option.name }))]} disabled={disabled} onChange={valueId => onChange({ ...value, valueId })} />
    {value.valueId && <>
      <PropertySelect id={`${id}-transition`} label={copy.transition} value={value.type} options={[{ value: 'instant', label: copy.transitionInstant }, { value: 'smart-animate', label: copy.transitionSmart }]} disabled={disabled} onChange={type => onChange({ ...value, type: type as InteractionDraft['type'] })} />
      {value.type === 'smart-animate' && <>
        <PropertyField id={`${id}-duration`} label={copy.duration} value={value.duration} type="number" suffix="ms" disabled={disabled} onChange={duration => onChange({ ...value, duration })} />
        <PropertySelect id={`${id}-easing`} label={copy.easing} value={value.easing} options={[...copy.easingOptions]} disabled={disabled} onChange={easing => onChange({ ...value, easing: easing as InteractionDraft['easing'] })} />
      </>}
    </>}
  </>
}

export function ComponentPropertyDialog({ componentId, property, type, nodes, unavailableNodeIds = [], interactions, siblingNames, container, disabled, onClose }: { componentId: string; property?: ComponentPropertyDefinition; type: ComponentPropertyDefinition['type']; nodes: readonly ComponentNodeChoice[]; unavailableNodeIds?: readonly string[]; interactions: readonly ComponentInteraction[]; siblingNames: readonly string[]; container: HTMLElement | null; disabled: boolean; onClose: () => void }) {
  const bindingNodes = componentPropertyBindingNodes(nodes, type, unavailableNodeIds)
  const defaultNodeId = bindingNodes[0]?.id ?? ''
  const defaultComponentId = bindingNodes[0]?.componentId ?? ''
  const defaultNode = documentStore.getSnapshot().file?.nodes[defaultNodeId]
  const [draft, setDraft] = useState(() => initialPropertyDraft(property, type, interactions, defaultNodeId, defaultComponentId, uniqueComponentDraftName(siblingNames, 'Property'), defaultNode?.type === 'text' ? defaultNode.text ?? 'Text' : 'Text', nodeAppearance(defaultNode)?.visible ?? true))
  const error = propertyDraftError(draft, type, siblingNames)
  const bindingMode = Boolean(property && !property.binding && bindingNodes.length > 0)
  const addOption = () => {
    const option = { id: crypto.randomUUID(), name: copy.value(draft.options.length + 1) }
    setDraft(current => ({ ...current, options: [...current.options, option] }))
  }
  const setOptions = (options: readonly VariantOptionDraft[]) => {
    const ids = new Set(options.map(option => option.id))
    const first = options[0]?.id ?? ''
    setDraft(current => ({
      ...current,
      options,
      defaultValueId: ids.has(current.defaultValueId) ? current.defaultValueId : first,
      currentValueId: ids.has(current.currentValueId)
        ? current.currentValueId
        : ids.has(current.defaultValueId) ? current.defaultValueId : first,
      hover: ids.has(current.hover.valueId) ? current.hover : { ...current.hover, valueId: '' },
      press: ids.has(current.press.valueId) ? current.press : { ...current.press, valueId: '' },
    }))
  }
  const save = () => {
    if (disabled || error) return
    const target = property ?? (type === 'variant'
      ? { id: crypto.randomUUID(), name: draft.name, type, values: draft.options, defaultValueId: draft.defaultValueId, currentValueId: draft.currentValueId }
      : type === 'text'
        ? { id: crypto.randomUUID(), name: draft.name, type, defaultValue: draft.defaultText }
        : type === 'boolean'
          ? { id: crypto.randomUUID(), name: draft.name, type, defaultValue: draft.defaultBoolean }
          : type === 'instance-swap'
            ? { id: crypto.randomUUID(), name: draft.name, type, defaultValue: draft.defaultComponentId, binding: { kind: 'instance-swap' as const, nodeId: draft.nodeId } }
          : { id: crypto.randomUUID(), name: draft.name, type })
    let next: ComponentPropertyDefinition
    if (target.type === 'variant') next = {
      ...target,
      name: draft.name.trim(),
      values: draft.options.map(option => ({ id: option.id, name: option.name.trim() })),
      defaultValueId: draft.defaultValueId,
      currentValueId: draft.currentValueId,
    }
    else if (target.type === 'text') next = { ...target, name: draft.name.trim(), defaultValue: draft.defaultText }
    else if (target.type === 'boolean') next = { ...target, name: draft.name.trim(), defaultValue: draft.defaultBoolean }
    else if (target.type === 'instance-swap') next = { ...target, name: draft.name.trim(), defaultValue: draft.defaultComponentId }
    else next = { ...target, name: draft.name.trim() }
    next = withPropertyDescription(next, draft.description)
    next = withBinding(next, bindingNodes.some(node => node.id === draft.nodeId) ? draft.nodeId : '')
    if (!replaceAuthoredProperty(componentId, next, draft.hover, draft.press)) return
    onClose()
  }
  const remove = property ? <Button label={copy.removeProperty(property.name)} variant="ghost" disabled={disabled} onClick={() => { if (documentStore.commands.components.removeProperty(componentId, property.id)) onClose() }}><Icon name="trash" />{copy.remove}</Button> : undefined
  return <ComponentAuthoringDialog open container={container} title={property ? bindingMode ? copy.bindPropertyTitle : copy.editPropertyTitle : copy.addPropertyTitle} closeLabel={copy.cancel} saveLabel={copy.saveProperty} {...(remove ? { leadingAction: remove } : {})} saveDisabled={disabled || Boolean(error)} onOpenChange={open => { if (!open) onClose() }} onSave={save}>
    <PropertyValue label={copy.propertyTypeLabel} value={copy.propertyType[type]} />
    <PropertyField id="component-property-dialog-name" label={copy.propertyName} value={draft.name} placeholder={copy.propertyNamePlaceholder[type]} disabled={disabled} onChange={name => setDraft(current => ({ ...current, name }))} />
    <PropertyField id="component-property-dialog-description" label={copy.description} value={draft.description} placeholder={copy.propertyDescriptionPlaceholder[type]} maxLength={componentDescriptionLimit} disabled={disabled} onChange={description => setDraft(current => ({ ...current, description }))} />
    {bindingNodes.length > 0 && <PropertySelect id="component-property-dialog-layer" label={copy.layer} value={draft.nodeId} options={bindingNodes.map(node => ({ value: node.id, label: node.name, icon: node.icon }))} disabled={disabled} onChange={nodeId => {
      const node = documentStore.getSnapshot().file?.nodes[nodeId]
      setDraft(current => ({
        ...current,
        nodeId,
        ...(type === 'text' && node?.type === 'text' ? { defaultText: node.text ?? 'Text' } : {}),
        ...(type === 'boolean' ? { defaultBoolean: nodeAppearance(node)?.visible ?? true } : {}),
        ...(type === 'instance-swap' ? { defaultComponentId: bindingNodes.find(candidate => candidate.id === nodeId)?.componentId ?? '' } : {}),
      }))
    }} />}
    {type === 'variant' && <>
      <ComponentAuthoringSection title={copy.options} action={<Button label={copy.addValue} variant="ghost" disabled={disabled} onClick={addOption}><Icon name="plus" />{copy.addValue}</Button>}>
        <ComponentOptionList>{draft.options.map((option, index) => <ComponentOptionRow key={option.id} action={<Button label={copy.removeValue(option.name)} variant="ghost" disabled={disabled || draft.options.length === 1} onClick={() => setOptions(draft.options.filter(candidate => candidate.id !== option.id))}><Icon name="trash" /></Button>}><PropertyField id={`component-property-dialog-option-${option.id}`} label={copy.value(index + 1)} value={option.name} placeholder={copy.optionPlaceholder(index + 1)} disabled={disabled} onChange={name => setOptions(draft.options.map(candidate => candidate.id === option.id ? { ...candidate, name } : candidate))} /></ComponentOptionRow>)}</ComponentOptionList>
      </ComponentAuthoringSection>
      <PropertySelect id="component-property-dialog-default" label={copy.defaultOption} value={draft.defaultValueId} options={draft.options.map(option => ({ value: option.id, label: option.name || copy.value(draft.options.indexOf(option) + 1) }))} disabled={disabled} onChange={defaultValueId => setDraft(current => ({ ...current, defaultValueId }))} />
      <ComponentAuthoringSection title={copy.prototype}>
        <InteractionFields id="component-property-dialog-hover" label={copy.interactionTarget['pointer-hover']} value={draft.hover} options={draft.options} disabled={disabled} onChange={hover => setDraft(current => ({ ...current, hover }))} />
        <InteractionFields id="component-property-dialog-press" label={copy.interactionTarget['pointer-press']} value={draft.press} options={draft.options} disabled={disabled} onChange={press => setDraft(current => ({ ...current, press }))} />
      </ComponentAuthoringSection>
    </>}
    {type === 'text' && <PropertyField id="component-property-dialog-default" label={copy.defaultValue} value={draft.defaultText} disabled={disabled} onChange={defaultText => setDraft(current => ({ ...current, defaultText }))} />}
    {type === 'boolean' && <PropertyToggle id="component-property-dialog-default" label={copy.defaultOn} checked={draft.defaultBoolean} disabled={disabled} onChange={defaultBoolean => setDraft(current => ({ ...current, defaultBoolean }))} />}
    {type === 'instance-swap' && <PropertyValue label={copy.defaultValue} value={bindingNodes.find(node => node.componentId === draft.defaultComponentId)?.name ?? copy.noLayer} />}
    {error && <ComponentAuthoringError>{error}</ComponentAuthoringError>}
  </ComponentAuthoringDialog>
}

type MaterialDraft = Readonly<{ name: string; group: string; description: string; nodeId: string; appearance: Appearance }>

export function materialDraftError(draft: Readonly<{ name: string; group: string; description: string; nodeId: string; appearance?: Appearance }>, siblingKeys: readonly string[]): string | null {
  if (!draft.name.trim() || !draft.group.trim()) return copy.propertyName
  const key = `${draft.group.trim().toLocaleLowerCase()}\u0000${draft.name.trim().toLocaleLowerCase()}`
  return siblingKeys.includes(key) ? copy.nameExists : null
}

export function canonicalMaterialGroup(value: string, groups: readonly string[]): string {
  const trimmed = value.trim()
  return groups.find(group => group.toLocaleLowerCase() === trimmed.toLocaleLowerCase()) ?? trimmed
}

export function ComponentMaterialDialog({ componentId, material, part, nodes, groups, siblingKeys, container, disabled, onClose }: { componentId: string; material?: ComponentMaterial; part?: ComponentPart; nodes: readonly ComponentNodeChoice[]; groups: readonly string[]; siblingKeys: readonly string[]; container: HTMLElement | null; disabled: boolean; onClose: () => void }) {
  const [draft, setDraft] = useState<MaterialDraft>(() => {
    const nodeId = part?.nodeId ?? nodes[0]?.id ?? ''
    const node = documentStore.getSnapshot().file?.nodes[nodeId]
    const group = material?.group ?? groups[0] ?? 'Layers'
    const siblingNames = siblingKeys.flatMap(key => {
      const [siblingGroup, siblingName] = key.split('\u0000')
      return siblingGroup === group.toLocaleLowerCase() && siblingName ? [siblingName] : []
    })
    return { name: material?.name ?? uniqueComponentDraftName(siblingNames, 'Material'), group, description: material?.description ?? '', nodeId, appearance: structuredClone(material?.appearance ?? nodeAppearance(node) ?? {}) }
  })
  const error = materialDraftError(draft, siblingKeys)
  const save = () => {
    if (disabled || error || !draft.nodeId) return
    const file = documentStore.getSnapshot().file
    const definition = file?.componentModel.definitions[componentId]
    const node = file?.nodes[draft.nodeId]
    if (!file || !definition || !node || node.type === 'root') return
    const id = material?.id ?? crypto.randomUUID()
    const nextMaterial: ComponentMaterial = { id, name: draft.name.trim(), group: canonicalMaterialGroup(draft.group, groups), description: draft.description.trim(), appearance: structuredClone(draft.appearance) }
    const appearanceChanged = !material || JSON.stringify(material.appearance) !== JSON.stringify(nextMaterial.appearance)
    const materials = material ? definition.materials.map(candidate => candidate.id === id ? nextMaterial : candidate) : [...definition.materials, nextMaterial]
    const nextDefinition = { ...definition, revision: definition.revision + 1, materials }
    const commands: FileCommand[] = [
      { type: 'component.replace', componentId, expectedRevision: definition.revision, definition: nextDefinition },
      ...(appearanceChanged ? componentMaterialProjectionCommands(nextDefinition, nextMaterial) : []),
    ]
    if (!documentStore.commands.executeBatch(commands)) return
    onClose()
  }
  const remove = material ? <Button label={copy.removeMaterial(material.name)} variant="ghost" disabled={disabled} onClick={() => { if (documentStore.commands.components.removeMaterial(componentId, material.id)) onClose() }}><Icon name="trash" />{copy.remove}</Button> : undefined
  return <ComponentAuthoringDialog open container={container} title={material ? copy.editMaterialTitle : copy.addMaterialTitle} closeLabel={copy.cancel} saveLabel={copy.saveMaterial} {...(remove ? { leadingAction: remove } : {})} saveDisabled={disabled || Boolean(error) || !draft.nodeId} onOpenChange={open => { if (!open) onClose() }} onSave={save}>
    <PropertyField id="component-material-dialog-name" label={copy.propertyName} value={draft.name} placeholder={copy.materialNamePlaceholder} disabled={disabled} onChange={name => setDraft(current => ({ ...current, name }))} />
    <PropertyField id="component-material-dialog-group" label={copy.group} value={draft.group} placeholder={copy.materialGroupPlaceholder} disabled={disabled} onChange={group => setDraft(current => ({ ...current, group }))} />
    <PropertyField id="component-material-dialog-description" label={copy.description} value={draft.description} placeholder={copy.materialDescriptionPlaceholder} maxLength={componentDescriptionLimit} disabled={disabled} onChange={description => setDraft(current => ({ ...current, description }))} />
    <PropertySelect id="component-material-dialog-layer" label={copy.captureFrom} value={draft.nodeId} options={nodes.map(node => ({ value: node.id, label: node.name, icon: node.icon }))} disabled={disabled || nodes.length === 0} onChange={nodeId => {
      const node = documentStore.getSnapshot().file?.nodes[nodeId]
      setDraft(current => ({ ...current, nodeId, appearance: structuredClone(nodeAppearance(node) ?? {}) }))
    }} />
    {material && <Button variant="ghost" disabled={disabled || !draft.nodeId} onClick={() => {
      const node = documentStore.getSnapshot().file?.nodes[draft.nodeId]
      if (node && node.type !== 'root') setDraft(current => ({ ...current, appearance: structuredClone(nodeAppearance(node) ?? {}) }))
    }}>{copy.updateMaterial}</Button>}
    {error && <ComponentAuthoringError>{error}</ComponentAuthoringError>}
  </ComponentAuthoringDialog>
}
