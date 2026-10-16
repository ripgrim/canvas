import { useState, useSyncExternalStore } from 'react'
import type { ComponentPropertyDefinition } from '@canvas/repo-engine/component-model'
import { descendantsOf } from '@canvas/repo-engine/file-document'
import { Button, Icon } from '../../design-system/atoms'
import { ComponentDefinitionGroup, ComponentDefinitionList, ComponentDefinitionRow, ComponentPropertyTypeMenu } from '../../design-system/component-kit-atoms'
import { PropertyGroup, PropertySelect, PropertyValue } from '../../design-system/property-atoms'
import { componentPropertyBindingNodes, ComponentMaterialDialog, ComponentPropertyDialog } from './component-authoring-dialogs'
import { documentStore } from './document-store'
import { componentKitCopy as copy } from './component-kit-copy'
import { layerPresentation } from './layer-presentation'

type EditorTarget =
  | Readonly<{ kind: 'property'; propertyId?: string; type: ComponentPropertyDefinition['type']; container: HTMLElement | null }>
  | Readonly<{ kind: 'material'; materialId?: string; container: HTMLElement | null }>

const editorContainer = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>('.editor-root') : null

export function ComponentMasterProperties() {
  const { file, selection, blocked } = useSyncExternalStore(documentStore.subscribe, documentStore.getViewSnapshot, documentStore.getViewSnapshot)
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  if (!file || selection.length !== 1) return null
  const definition = Object.values(file.componentModel.definitions).find(candidate => candidate.source.kind === 'canvas' && candidate.source.masterRootId === selection[0])
  if (!definition || definition.source.kind !== 'canvas') return null
  const masterRootId = definition.source.masterRootId
  const nodeIds = [masterRootId, ...descendantsOf(file, masterRootId)]
  const nodes = nodeIds.flatMap(nodeId => {
    const node = file.nodes[nodeId]
    const presentation = layerPresentation(file, nodeId)
    const instance = file.componentModel.instances[nodeId]
    const nested = instance ? file.componentModel.definitions[instance.componentId] : undefined
    const componentId = nodeId !== masterRootId && nested?.source.kind === 'canvas' ? nested.id : undefined
    return node && node.type !== 'root' && presentation ? [{ id: node.id, name: componentId ? nested?.name ?? presentation.name : presentation.name, type: node.type, icon: componentId ? 'component' as const : presentation.icon, ...(componentId ? { componentId } : {}) }] : []
  })
  const unavailableSwapNodeIds = definition.properties.flatMap(property => property.type === 'instance-swap' ? [property.binding.nodeId] : [])
  const propertyOptions = copy.propertyOptions.map(option => {
    const disabled = componentPropertyBindingNodes(nodes, option.value, option.value === 'instance-swap' ? unavailableSwapNodeIds : []).length === 0
    return { ...option, disabled, ...(disabled ? { reason: copy.propertyUnavailable[option.value] } : {}) }
  })
  const propertyIcon = (type: ComponentPropertyDefinition['type']) => {
    const option = copy.propertyOptions.find(candidate => candidate.value === type)
    if (!option) throw new Error(`Missing component property presentation for ${type}`)
    return option.icon
  }
  const nodeName = (nodeId: string | undefined) => nodes.find(node => node.id === nodeId)?.name ?? copy.noLayer
  const propertyDetail = (property: ComponentPropertyDefinition) => {
    if (!property.binding) return copy.unboundProperty
    if (property.type !== 'variant') return copy.boundLayer(nodeName(property.binding.nodeId))
    const valueId = property.currentValueId ?? property.defaultValueId
    const value = property.values.find(candidate => candidate.id === valueId)
    return copy.variantEditing(nodeName(property.binding.nodeId), value?.name ?? '')
  }
  const componentName = (componentId: string) => file.componentModel.definitions[componentId]?.name ?? componentId
  const materialGroups = definition.materials.reduce<Array<{ name: string; materials: Array<(typeof definition.materials)[number]> }>>((groups, material) => {
    const group = groups.find(candidate => candidate.name === material.group)
    if (group) group.materials.push(material)
    else groups.push({ name: material.group, materials: [material] })
    return groups
  }, [])
  return <>
    <PropertyGroup title={copy.properties} action={<ComponentPropertyTypeMenu label={copy.addProperty} disabled={blocked} options={propertyOptions} onSelect={(type, target) => setEditor({ kind: 'property', type: type as ComponentPropertyDefinition['type'], container: editorContainer(target) })} />}>
      <ComponentDefinitionList>{definition.properties.map(property => {
        const edit = (target: EventTarget | null) => setEditor({ kind: 'property', propertyId: property.id, type: property.type, container: editorContainer(target) })
        const unavailableNodeIds = property.type === 'variant'
          ? definition.properties.flatMap(candidate => candidate.id !== property.id && candidate.type === 'variant' && candidate.binding ? [candidate.binding.nodeId] : [])
          : property.type === 'instance-swap'
            ? definition.properties.flatMap(candidate => candidate.id !== property.id && candidate.type === 'instance-swap' ? [candidate.binding.nodeId] : [])
            : []
        const canBind = componentPropertyBindingNodes(nodes, property.type, unavailableNodeIds).length > 0
        const action = property.binding || !canBind ? { editLabel: copy.editProperty(property.name), editText: copy.edit } : { editLabel: copy.bindProperty(property.name), editText: copy.bind }
        if (property.type === 'variant') {
          return <ComponentDefinitionRow key={property.id} name={property.name} type={`${copy.propertyType[property.type]} · ${copy.variantOptionCount(property.values.length)}`} typeIcon={propertyIcon(property.type)} detail={propertyDetail(property)} controlLabel={copy.currentVariant} {...action} disabled={blocked} onEdit={edit} control={<PropertySelect key={property.values.map(value => value.id).join(':')} id={`component-property-${property.id}-current`} label={copy.currentVariant} value={property.currentValueId ?? property.defaultValueId} options={property.values.map(value => ({ value: value.id, label: value.name }))} disabled={blocked || !property.binding} onChange={valueId => documentStore.commands.components.setVariantCurrent(definition.id, property.id, valueId)} />} />
        }
        if (property.type === 'text') return <ComponentDefinitionRow key={property.id} name={property.name} type={copy.propertyType[property.type]} typeIcon={propertyIcon(property.type)} detail={propertyDetail(property)} {...action} disabled={blocked} onEdit={edit} control={<PropertyValue label={copy.defaultValue} value={property.defaultValue} />} />
        if (property.type === 'boolean') return <ComponentDefinitionRow key={property.id} name={property.name} type={copy.propertyType[property.type]} typeIcon={propertyIcon(property.type)} detail={propertyDetail(property)} {...action} disabled={blocked} onEdit={edit} control={<PropertyValue label={copy.defaultValue} value={property.defaultValue ? copy.on : copy.off} />} />
        if (property.type === 'instance-swap') return <ComponentDefinitionRow key={property.id} name={property.name} type={copy.propertyType[property.type]} typeIcon={propertyIcon(property.type)} detail={propertyDetail(property)} {...action} disabled={blocked} onEdit={edit} control={<PropertyValue label={copy.defaultValue} value={componentName(property.defaultValue)} />} />
        return <ComponentDefinitionRow key={property.id} name={property.name} type={copy.propertyType[property.type]} typeIcon={propertyIcon(property.type)} detail={propertyDetail(property)} {...action} disabled={blocked} onEdit={edit} />
      })}</ComponentDefinitionList>
    </PropertyGroup>
    <PropertyGroup title={copy.materials} action={<Button label={copy.addMaterial} variant="ghost" disabled={blocked || nodes.length === 0} onClick={event => setEditor({ kind: 'material', container: editorContainer(event.currentTarget) })}><Icon name="plus" /></Button>}>
      {materialGroups.map(group => <ComponentDefinitionGroup key={group.name} name={group.name}>{group.materials.map(material => <ComponentDefinitionRow key={material.id} name={material.name} type={copy.materialUsage(definition.parts.filter(part => part.materialId === material.id).length)} {...(material.description ? { detail: material.description } : {})} editLabel={copy.editMaterial(material.name)} editText={copy.edit} disabled={blocked} onEdit={target => setEditor({ kind: 'material', materialId: material.id, container: editorContainer(target) })} />)}</ComponentDefinitionGroup>)}
    </PropertyGroup>
    {definition.materials.length > 0 && <PropertyGroup title={copy.parts}>
      {nodes.map(node => {
        const part = definition.parts.find(candidate => candidate.nodeId === node.id)
        return <PropertySelect key={node.id} id={`component-part-${node.id}-material`} label={node.name} value={part?.materialId ?? ''} options={[{ value: '', label: copy.noMaterial }, ...definition.materials.map(material => ({ value: material.id, label: material.name, group: material.group }))]} disabled={blocked} onChange={materialId => materialId ? documentStore.commands.components.assignMaterial(definition.id, materialId, node.id) : documentStore.commands.components.clearMaterial(definition.id, node.id)} />
      })}
    </PropertyGroup>}
    {editor?.kind === 'property' && (() => {
      const property = editor.propertyId ? definition.properties.find(candidate => candidate.id === editor.propertyId) : undefined
      const unavailableNodeIds = editor.type === 'variant'
        ? definition.properties.flatMap(candidate => candidate.id !== editor.propertyId && candidate.type === 'variant' && candidate.binding ? [candidate.binding.nodeId] : [])
        : editor.type === 'instance-swap'
          ? definition.properties.flatMap(candidate => candidate.id !== editor.propertyId && candidate.type === 'instance-swap' ? [candidate.binding.nodeId] : [])
          : []
      return <ComponentPropertyDialog key={`${editor.propertyId ?? 'new'}:${editor.type}`} componentId={definition.id} {...(property ? { property } : {})} type={editor.type} nodes={nodes} unavailableNodeIds={unavailableNodeIds} interactions={definition.interactions} siblingNames={definition.properties.filter(candidate => candidate.id !== editor.propertyId).map(candidate => candidate.name)} container={editor.container} disabled={blocked} onClose={() => setEditor(null)} />
    })()}
    {editor?.kind === 'material' && (() => {
      const material = editor.materialId ? definition.materials.find(candidate => candidate.id === editor.materialId) : undefined
      const part = material ? definition.parts.find(candidate => candidate.materialId === material.id) : undefined
      return <ComponentMaterialDialog key={editor.materialId ?? 'new'} componentId={definition.id} {...(material ? { material } : {})} {...(part ? { part } : {})} nodes={nodes} groups={materialGroups.map(group => group.name)} siblingKeys={definition.materials.filter(candidate => candidate.id !== editor.materialId).map(candidate => `${candidate.group.toLocaleLowerCase()}\u0000${candidate.name.toLocaleLowerCase()}`)} container={editor.container} disabled={blocked} onClose={() => setEditor(null)} />
    })()}
  </>
}
