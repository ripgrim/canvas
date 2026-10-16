import { useState, useSyncExternalStore } from 'react'
import { Input } from '../../design-system/atoms'
import { ComponentAuthoringDialog, ComponentAuthoringError } from '../../design-system/component-kit-atoms'
import { componentKitCopy as copy } from './component-kit-copy'
import { componentKitNavigation } from './component-kit-navigation'
import { componentCreationCandidate, componentCreationService } from './component-creation-service'
import type { ComponentCreationRequest } from './component-creation-service'
import { documentStore } from './document-store'

function RequestDialog({ request }: { request: ComponentCreationRequest }) {
  const document = useSyncExternalStore(documentStore.subscribe, documentStore.getViewSnapshot, documentStore.getViewSnapshot)
  const node = document.file?.fileId === request.fileId ? document.file.nodes[request.nodeId] : undefined
  const [name, setName] = useState(node && node.type !== 'root' ? node.name ?? 'Component' : 'Component')
  const duplicate = Boolean(document.file && Object.values(document.file.componentModel.definitions).some(definition => definition.name.localeCompare(name.trim(), undefined, { sensitivity: 'accent' }) === 0))
  const current = componentCreationCandidate(document.file, document.selection) === request.nodeId
  const save = () => {
    if (!current || duplicate || !name.trim()) return
    if (!documentStore.commands.components.createFromSelection(name)) return
    const file = documentStore.getSnapshot().file
    const definition = file && Object.values(file.componentModel.definitions).find(candidate => candidate.source.kind === 'canvas' && candidate.source.masterRootId === request.nodeId)
    componentCreationService.close()
    if (file && definition) componentKitNavigation.open(file.fileId, definition.id)
  }
  return <ComponentAuthoringDialog open container={request.container} title={copy.create} closeLabel={copy.cancel} saveLabel={copy.create} saveDisabled={!current || duplicate || !name.trim() || document.blocked} onOpenChange={open => { if (!open) componentCreationService.close() }} onSave={save}>
    <Input id="component-name" label={copy.name} value={name} autoFocus aria-invalid={duplicate} onChange={event => setName(event.currentTarget.value)} />
    {duplicate && <ComponentAuthoringError>{copy.nameExists}</ComponentAuthoringError>}
  </ComponentAuthoringDialog>
}

export function ComponentCreationDialog() {
  const request = useSyncExternalStore(componentCreationService.subscribe, componentCreationService.getSnapshot, componentCreationService.getSnapshot)
  return request ? <RequestDialog key={request.sequence} request={request} /> : null
}
