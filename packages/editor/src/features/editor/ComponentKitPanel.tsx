import { useCallback, useState, useSyncExternalStore } from 'react'
import { componentDescriptionLimit, componentDocsManifest, componentVariantCombinationLabel, resolveComponentInstanceValues } from '@canvas/repo-engine/component-model'
import type { ComponentDefinition, ComponentInstanceValues, ComponentScalarValue } from '@canvas/repo-engine/component-model'
import { pageNodes, pageOfNode } from '@canvas/repo-engine/file-document'
import type { Atom } from './types'
import { Button, Icon, Text } from '../../design-system/atoms'
import { ComponentAuthoringDialog, ComponentAuthoringError, ComponentCombinationList, ComponentCombinationRow, ComponentDefinitionList, ComponentDefinitionRow, ComponentDocsActions, ComponentDocsHeader, ComponentDocsPreview, ComponentKitEmpty, ComponentKitList, ComponentKitRow, ComponentKitSection, ComponentPlaygroundControl, ComponentPropertyTypeMenu, ComponentPropertyValueRow, ComponentUseRow } from '../../design-system/component-kit-atoms'
import { PropertyField, PropertyGroup, PropertyHint, PropertySelect, PropertyToggle, PropertyValue } from '../../design-system/property-atoms'
import { documentStore } from './document-store'
import { componentKitCopy as copy } from './component-kit-copy'
import { componentKitNavigation } from './component-kit-navigation'
import { validComponentPreviewValues } from './component-docs-preview-service'
import type { createComponentDocsPreviewService } from './component-docs-preview-service'
import { editorStore } from './store'
import { componentConfigurableDefinition } from './component-property-projection'
import { eligibleSlotDraftComponents } from './component-configured-instance'
import { eligibleInstanceSwapComponents } from './component-instance-swap'

const defaultFor = (property: ComponentDefinition['properties'][number]): ComponentScalarValue | undefined => property.type === 'variant' ? property.defaultValueId : property.type === 'text' || property.type === 'boolean' || property.type === 'instance-swap' ? property.defaultValue : undefined

function sparseValues(definition: ComponentDefinition, values: ComponentInstanceValues, authored: ComponentInstanceValues = values): ComponentInstanceValues {
  return Object.fromEntries(definition.properties.flatMap(property => {
    const value = values[property.id]
    if (property.optional && !Object.hasOwn(authored, property.id)) return []
    const fallback = defaultFor(property)
    return value === undefined || !property.optional && value === fallback ? [] : [[property.id, value]]
  }))
}

function combinationIsSelected(definition: ComponentDefinition, combination: ComponentInstanceValues, values: ComponentInstanceValues): boolean {
  return definition.properties.filter(property => property.type === 'variant').every(property => values[property.id] === combination[property.id])
}

type ComponentUse = Readonly<{ id: string; pageId: string; pageName: string; index: number }>

function ComponentDocsView({ definition, uses, available, blocked, previewUrl, previewService, onBack, onOpenCanvas, onOpenUse }: { definition: ComponentDefinition; uses: readonly ComponentUse[]; available: boolean; blocked: boolean; previewUrl: string | null; previewService: ReturnType<typeof createComponentDocsPreviewService>; onBack: () => void; onOpenCanvas: () => void; onOpenUse: (use: ComponentUse) => void }) {
  const configurableDefinition = componentConfigurableDefinition(definition)
  const manifest = componentDocsManifest(configurableDefinition)
  const hasProperties = configurableDefinition.properties.length > 0
  const hasVariants = configurableDefinition.properties.some(property => property.type === 'variant')
  const preview = useSyncExternalStore(previewService.subscribe, previewService.getSnapshot, previewService.getSnapshot)
  const resolvedValues = resolveComponentInstanceValues(configurableDefinition, validComponentPreviewValues(configurableDefinition, preview.values))
  const currentFile = documentStore.getSnapshot().file
  const slotComponents = currentFile ? eligibleSlotDraftComponents(currentFile, configurableDefinition) : []
  const swapComponents = currentFile ? eligibleInstanceSwapComponents(currentFile, configurableDefinition) : []
  const [draftDetails, setDraftDetails] = useState<Readonly<{ name: string; description: string; container: HTMLElement | null }> | null>(null)
  const detailsError = draftDetails && Object.values(documentStore.getSnapshot().file?.componentModel.definitions ?? {}).some(candidate => candidate.id !== definition.id && candidate.name.localeCompare(draftDetails.name.trim(), undefined, { sensitivity: 'accent' }) === 0) ? copy.nameExists : undefined
  const update = (propertyId: string, value: ComponentScalarValue) => previewService.setValue(propertyId, value)
  const attachPreview = useCallback((element: HTMLIFrameElement | null) => {
    if (!element?.contentWindow) { previewService.disconnect(); return }
    previewService.connect(element.contentWindow, { width: element.clientWidth, height: element.clientHeight })
  }, [previewService])
  const readyPreview = useCallback(() => previewService.ping(), [previewService])
  const place = (next: ComponentInstanceValues, drafts = previewService.getSnapshot().slotDrafts) => documentStore.commands.components.place(definition.id, next, drafts)
  const placeConfigured = () => {
    const current = previewService.getSnapshot()
    const resolved = resolveComponentInstanceValues(configurableDefinition, validComponentPreviewValues(configurableDefinition, current.values))
    return place(sparseValues(configurableDefinition, resolved, current.values), current.slotDrafts)
  }
  return <>
    <ComponentDocsHeader name={definition.name} source={definition.source.kind === 'code' ? copy.fromKit : copy.fromCanvas} {...(manifest.description ? { description: manifest.description } : {})} backLabel={copy.backToComponents} onBack={onBack} />
    <ComponentDocsActions>
      <Button variant="primary" disabled={!available || blocked} onClick={placeConfigured}><Icon name="plus" />{copy.placeConfigured}</Button>
      {definition.source.kind === 'canvas' && <Button variant="outline" disabled={blocked} onClick={() => { if (documentStore.commands.components.openMaster(definition.id)) onOpenCanvas() }}><Icon name="target" />{copy.openCanvas}</Button>}
      {definition.source.kind === 'canvas' && <Button label={copy.editComponentDetails(definition.name)} variant="ghost" disabled={blocked || draftDetails !== null} onClick={event => setDraftDetails({ name: definition.name, description: definition.docs?.description ?? '', container: event.currentTarget.closest<HTMLElement>('.editor-root') })}>{copy.editDetails}</Button>}
      {definition.source.kind === 'canvas' && <Button label={copy.removeComponent(definition.name)} variant="ghost" disabled={blocked} onClick={() => { if (documentStore.commands.components.remove(definition.id)) onBack() }}><Icon name="trash" />{copy.removeComponentAction}</Button>}
    </ComponentDocsActions>
    {!available && <PropertyHint>{copy.unavailable}</PropertyHint>}
    {previewUrl && definition.source.kind === 'canvas' && <ComponentDocsPreview key={previewUrl} src={previewUrl} title={copy.configuredPreview} status={preview.status} statusText={preview.status === 'error' ? copy.previewUnavailable : copy.previewConnecting} {...(preview.status === 'error' ? { action: <Button variant="ghost" onClick={() => previewService.retry()}>{copy.retryPreview}</Button> } : {})} attach={attachPreview} onReady={readyPreview} />}
    {hasProperties && <PropertyGroup title={copy.playground} {...(Object.keys(preview.values).length || preview.slotDrafts.length ? { action: <Button label={copy.resetPlayground} variant="ghost" disabled={blocked} onClick={() => previewService.reset()}><Icon name="refresh" /></Button> } : {})}>
      {configurableDefinition.properties.map(property => {
        const id = `component-docs-${definition.id}-${property.id}`
        const overridden = Object.hasOwn(preview.values, property.id)
        const control = property.type === 'variant'
          ? <PropertySelect id={id} label={property.name} value={property.optional && !overridden ? '' : String(resolvedValues[property.id])} options={[...(property.optional ? [{ value: '', label: copy.componentDefault }] : []), ...property.values.map(value => ({ value: value.id, label: value.name }))]} disabled={blocked} onChange={value => value === '' ? previewService.resetValue(property.id) : update(property.id, value)} />
          : property.type === 'text'
            ? <PropertyField id={id} label={property.name} value={property.optional && !overridden ? '' : String(resolvedValues[property.id])} {...(property.optional && !overridden ? { mixed: copy.componentDefault } : {})} disabled={blocked} onChange={value => update(property.id, value)} />
            : property.type === 'boolean' && property.optional
              ? <PropertySelect id={id} label={property.name} value={overridden ? String(resolvedValues[property.id]) : ''} options={[{ value: '', label: copy.componentDefault }, { value: 'true', label: copy.on }, { value: 'false', label: copy.off }]} disabled={blocked} onChange={value => value === '' ? previewService.resetValue(property.id) : update(property.id, value === 'true')} />
              : property.type === 'boolean'
                ? <PropertyToggle id={id} label={property.name} checked={Boolean(resolvedValues[property.id])} disabled={blocked} onChange={value => update(property.id, value)} />
              : property.type === 'instance-swap'
                ? <PropertySelect id={id} label={property.name} value={String(resolvedValues[property.id])} options={swapComponents.map(candidate => ({ value: candidate.id, label: candidate.name, icon: 'component' as const }))} disabled={blocked || swapComponents.length === 0} onChange={componentId => previewService.setValue(property.id, componentId)} />
              : property.type === 'slot' && definition.source.kind === 'canvas'
                ? (() => {
                    const drafts = preview.slotDrafts.filter(draft => draft.propertyId === property.id)
                    const options = [...copy.slotOptions, ...slotComponents.map(candidate => ({ value: `component:${candidate.id}`, label: candidate.name, icon: 'component' as const, group: copy.slotComponents }))]
                    return <>
                      <ComponentPropertyValueRow action={<ComponentPropertyTypeMenu label={copy.addSlotContent(property.name)} disabled={blocked || !property.binding} options={options} onSelect={kind => kind.startsWith('component:') ? previewService.addSlotComponent(property.id, kind.slice('component:'.length)) : previewService.addSlotContent(property.id, kind as 'text' | 'frame')} />}>
                        <PropertyValue label={property.name} value={copy.slotCount(drafts.length)} />
                      </ComponentPropertyValueRow>
                      {drafts.length > 0 && <ComponentDefinitionList>{drafts.map(draft => {
                        const nested = draft.content.kind === 'component' ? currentFile?.componentModel.definitions[draft.content.componentId] : undefined
                        const name = draft.content.kind === 'component' ? nested?.name ?? copy.component : draft.content.kind === 'text' ? copy.textLayer : copy.frameLayer
                        const type = draft.content.kind === 'component' ? copy.component : copy.layer
                        const icon = draft.content.kind === 'component' ? 'component' as const : draft.content.kind === 'text' ? 'text' as const : 'frame' as const
                        return <ComponentDefinitionRow key={draft.id} name={name} type={type} typeIcon={icon} editLabel={copy.removeSlotDraft(name)} editText={copy.remove} disabled={blocked} onEdit={() => previewService.removeSlotDraft(draft.id)} />
                      })}</ComponentDefinitionList>}
                    </>
                  })()
                : <PropertyValue label={property.name} value={copy.slotValue} />
        return <ComponentPlaygroundControl key={property.id} {...(property.description ? { description: property.description } : {})}>{control}</ComponentPlaygroundControl>
      })}
    </PropertyGroup>}
    {uses.length > 0 && <PropertyGroup title={copy.instances}>
      <ComponentCombinationList label={copy.instances}>{uses.map(use => <ComponentUseRow key={use.id} name={use.pageName} detail={copy.instance(use.index)} action={<Button label={copy.openInstance(definition.name, use.index, use.pageName)} variant="ghost" disabled={blocked} onClick={() => onOpenUse(use)}><Icon name="target" /></Button>} />)}</ComponentCombinationList>
    </PropertyGroup>}
    {hasVariants && <PropertyGroup title={copy.variantSheet} {...(definition.source.kind === 'canvas' ? { action: <Button label={copy.placeVariantSheetFor(definition.name)} variant="ghost" disabled={blocked} onClick={() => documentStore.commands.components.placeVariantSheet(definition.id)}><Icon name="plus" />{copy.placeVariantSheet}</Button> } : {})}>
      <ComponentCombinationList label={copy.variantSheet}>{manifest.combinations.map(combination => {
        const summary = componentVariantCombinationLabel(configurableDefinition, combination, copy.defaultCombination)
        return <ComponentCombinationRow key={JSON.stringify(combination)} summary={summary} preview={{ label: copy.previewCombination(summary), selected: combinationIsSelected(configurableDefinition, combination, resolvedValues), onSelect: () => previewService.setValues(combination) }} action={<Button label={copy.placeCombination(summary)} variant="ghost" disabled={!available || blocked} onClick={() => place(sparseValues(configurableDefinition, combination))}><Icon name="plus" /></Button>} />
      })}</ComponentCombinationList>
    </PropertyGroup>}
    {manifest.usage.status === 'available' && <PropertyGroup title={copy.usage}><PropertyValue label={copy.usage} value={manifest.usage.snippet} /></PropertyGroup>}
    {draftDetails && <ComponentAuthoringDialog open container={draftDetails.container} title={copy.editDetailsTitle} closeLabel={copy.cancel} saveLabel={copy.saveDetails} saveDisabled={blocked || !draftDetails.name.trim() || Boolean(detailsError)} onOpenChange={open => { if (!open) setDraftDetails(null) }} onSave={() => { if (documentStore.commands.components.setDetails(definition.id, draftDetails)) setDraftDetails(null) }}>
      <PropertyField id={`component-details-${definition.id}-name`} label={copy.name} value={draftDetails.name} disabled={blocked} onChange={name => setDraftDetails(current => current ? { ...current, name } : current)} />
      <PropertyField id={`component-details-${definition.id}-description`} label={copy.description} value={draftDetails.description} maxLength={componentDescriptionLimit} disabled={blocked} onChange={description => setDraftDetails(current => current ? { ...current, description } : current)} />
      {detailsError && <ComponentAuthoringError>{detailsError}</ComponentAuthoringError>}
    </ComponentAuthoringDialog>}
  </>
}

export function ComponentKitPanel({ atoms, onOpenCanvas }: { atoms: Atom[]; onOpenCanvas: () => void }) {
  const document = useSyncExternalStore(documentStore.subscribe, documentStore.getViewSnapshot, documentStore.getViewSnapshot)
  const kitLocation = useSyncExternalStore(componentKitNavigation.subscribe, componentKitNavigation.getSnapshot, componentKitNavigation.getSnapshot)
  const previewUrl = useSyncExternalStore(editorStore.subscribe, () => editorStore.getSnapshot().snapshot?.preview.url ?? null, () => null)
  const [draftName, setDraftName] = useState<string | null>(null)
  const definitions = Object.values(document.file?.componentModel.definitions ?? {}).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  const instanceCounts = Object.values(document.file?.componentModel.instances ?? {}).reduce((counts, instance) => counts.set(instance.componentId, (counts.get(instance.componentId) ?? 0) + 1), new Map<string, number>())
  const openComponentId = kitLocation && kitLocation.fileId === document.file?.fileId ? kitLocation.componentId : null
  const openDefinition = openComponentId ? definitions.find(definition => definition.id === openComponentId) : undefined
  const previewService = componentKitNavigation.playground(kitLocation)
  if (openDefinition && previewService) {
    const available = openDefinition.source.kind !== 'code' || atoms.some(atom => atom.componentId === openDefinition.id && atom.status === 'bound')
    const pageIndex = new Map(document.file!.pages.map((page, index) => [page.id, index]))
    const nodeIndex = new Map(document.file!.pages.flatMap(page => pageNodes(document.file!, page.id).map((nodeId, index) => [nodeId, index] as const)))
    const uses = Object.values(document.file!.componentModel.instances).filter(instance => instance.componentId === openDefinition.id).flatMap(instance => {
      const pageId = pageOfNode(document.file!, instance.id)
      const page = pageId ? document.file!.pages.find(candidate => candidate.id === pageId) : undefined
      return page ? [{ id: instance.id, pageId: page.id, pageName: page.name, index: 0 }] : []
    }).sort((left, right) => (pageIndex.get(left.pageId) ?? 0) - (pageIndex.get(right.pageId) ?? 0) || (nodeIndex.get(left.id) ?? 0) - (nodeIndex.get(right.id) ?? 0)).map((use, index, all) => ({ ...use, index: all.slice(0, index + 1).filter(candidate => candidate.pageId === use.pageId).length }))
    const openUse = (use: ComponentUse) => {
      if (documentStore.getSnapshot().pageId !== use.pageId && !documentStore.setPage(use.pageId)) return
      documentStore.select(use.id)
      if (documentStore.getSnapshot().selection[0] === use.id) onOpenCanvas()
    }
    return <ComponentDocsView key={openDefinition.id} definition={openDefinition} uses={uses} available={available} blocked={document.blocked} previewUrl={previewUrl} previewService={previewService} onBack={() => componentKitNavigation.back()} onOpenCanvas={onOpenCanvas} onOpenUse={openUse} />
  }
  const content = definitions.length === 0 ? <ComponentKitEmpty title={copy.emptyTitle} /> : <ComponentKitList label={copy.label}>{definitions.map(definition => {
    const fromCode = definition.source.kind === 'code'
    const available = !fromCode || atoms.some(atom => atom.componentId === definition.id && atom.status === 'bound')
    return <ComponentKitRow key={definition.id} name={definition.name} source={copy.componentSummary(fromCode ? copy.fromKit : copy.fromCanvas, instanceCounts.get(definition.id) ?? 0)} onInspect={{ label: copy.inspect(definition.name), action: () => { if (document.file) componentKitNavigation.open(document.file.fileId, definition.id) } }} disabled={!available || document.blocked} onPlace={{ label: available ? copy.place(definition.name) : copy.unavailable, action: () => documentStore.commands.components.place(definition.id) }} {...(!fromCode ? { onOpen: { label: copy.open(definition.name), action: () => { if (documentStore.commands.components.openMaster(definition.id)) onOpenCanvas() } } } : {})} />
  })}</ComponentKitList>
  return <ComponentKitSection title={copy.components}>{content}</ComponentKitSection>
}
