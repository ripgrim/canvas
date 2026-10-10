import { useState, useSyncExternalStore } from 'react'
import { Button, Disclosure, Layout, Text } from '../../design-system/atoms'
import { InspectorField, Message, ValuePair } from '../../design-system/molecules'
import { RepositoryBulkImport, RepositoryComponentList, RepositoryDiagnostics, RepositoryTokenList, RepositoryTokenRow, RepositoryTokenSelectAll } from '../../design-system/repository-molecules'
import type { CapabilityState } from '../../capabilities'
import { documentStore } from './document-store'
import { repositoryConnectionService as service } from './repository-service'
import { repositoryCopy as copy } from './repository-copy'
import { repositoryTokenCatalog } from './repository-token-import'
import { editorStore } from './store'

export function RepositoryPanel({ local, git }: { local: CapabilityState; git: CapabilityState }) {
  const state = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot)
  const runtime = useSyncExternalStore(editorStore.subscribe, () => editorStore.getSnapshot().capabilities.runtime, () => editorStore.getSnapshot().capabilities.runtime)
  const [owner, setOwner] = useState('')
  const [name, setName] = useState('')
  const [selectedTokens, setSelectedTokens] = useState<Set<string>>(() => new Set())
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null)
  const document = useSyncExternalStore(documentStore.subscribe, documentStore.getViewSnapshot, documentStore.getViewSnapshot)
  const busy = state.status === 'busy'
  const connection = state.connection
  const configs = connection?.scan.configs ?? []
  const manifestConfigs = configs.filter(config => config.source === 'manifest')
  const inferredConfigs = configs.filter(config => config.source === 'inferred')
  const discovery = manifestConfigs.length && inferredConfigs.length
    ? copy.mixedDiscovery
    : manifestConfigs.length
      ? copy.manifestDiscovery
      : copy.inferredDiscovery(inferredConfigs.map(config => config.workspace || copy.repositoryRoot))
  const discoveryLabel = inferredConfigs.length && !manifestConfigs.length ? copy.autoDetected : copy.discovery
  const available = local.available || git.available
  const canClone = git.available && !busy && owner.trim().length > 0 && name.trim().length > 0
  const catalog = repositoryTokenCatalog(connection?.scan.tokens ?? [])
  const imported = new Set(Object.values(document.file?.theme.tokens ?? {}).flatMap(token => token.value.kind === 'source' ? [token.value.property] : []))
  const selectable = new Set(catalog.colors.filter(token => !imported.has(token.property)).map(token => token.property))
  const selectableOrder = catalog.colors.filter(token => selectable.has(token.property)).map(token => token.property)
  const selected = [...selectedTokens].filter(property => selectable.has(property))
  // Repository access is a desktop capability. Browser drafts keep this surface absent rather than advertising dead actions.
  if (runtime !== 'desktop' || !available) return null
  const selectToken = (property: string, checked: boolean, range: boolean) => {
    setSelectedTokens(current => {
      const next = new Set([...current].filter(item => selectable.has(item)))
      const anchorIndex = selectionAnchor ? selectableOrder.indexOf(selectionAnchor) : -1
      const targetIndex = selectableOrder.indexOf(property)
      const properties = range && anchorIndex >= 0 && targetIndex >= 0
        ? selectableOrder.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1)
        : [property]
      for (const item of properties) {
        if (checked) next.add(item)
        else next.delete(item)
      }
      return next
    })
    setSelectionAnchor(property)
  }
  const importTokens = (properties: readonly string[]) => {
    const wanted = new Set(properties)
    const entries = catalog.colors.filter(token => wanted.has(token.property))
    if (!entries.length) return
    const count = documentStore.commands.theme.importSourceTokens(entries)
    if (count) {
      setSelectedTokens(current => new Set([...current].filter(property => !wanted.has(property))))
      setSelectionAnchor(current => current && wanted.has(current) ? null : current)
    }
  }
  return <Layout roleName="stack">
    {connection ? <>
      <ValuePair label={copy.scanned} value={connection.repository.name} />
      <ValuePair label={copy.source} value={connection.repository.source === 'local' ? copy.localSource : copy.cloneSource} />
      {configs.length ? <>
        <ValuePair label={discoveryLabel} value={discovery} />
        <Text roleName="muted">{copy.counts(connection.scan.components.length, catalog.colors.length)}</Text>
        <Text roleName="muted">{copy.boundary}</Text>
        <Disclosure title={copy.components(connection.scan.components.length)} open={false}><RepositoryComponentList label={copy.componentList} components={connection.scan.components} /><Text roleName="muted">{copy.componentImportLater}</Text></Disclosure>
        <Disclosure title={copy.tokens(catalog.colors.length)} open={false}>
          <RepositoryTokenList label={copy.tokenList} count={catalog.colors.length} header={<RepositoryTokenSelectAll label={copy.selectAllTokens} checked={selectable.size > 0 && selected.length === selectable.size} disabled={!document.file || document.blocked || selectable.size === 0} onChange={checked => { setSelectedTokens(checked ? new Set(selectable) : new Set()); setSelectionAnchor(null) }} />} action={selected.length >= 2 ? <RepositoryBulkImport label={copy.importMany(selected.length)} onImport={() => importTokens(selected)} /> : undefined}>{catalog.colors.map(token => <RepositoryTokenRow key={token.property} property={token.property} name={token.name} color={token.color} selected={selected.includes(token.property)} imported={imported.has(token.property)} disabled={!document.file || document.blocked} selectLabel={copy.selectToken(token.name)} importLabel={copy.importToken} importedLabel={copy.imported} swatchLabel={copy.swatch(token.name)} onSelect={(checked, range) => selectToken(token.property, checked, range)} onImport={() => importTokens([token.property])} />)}</RepositoryTokenList>
          {!document.file && <Text roleName="muted">{copy.openFileToImport}</Text>}
          {catalog.hidden > 0 && <Text roleName="muted">{copy.hiddenVariables(catalog.hidden)}</Text>}
        </Disclosure>
      </> : <Message title={copy.unsupportedTitle} body={copy.unsupportedBody} />}
      {connection.scan.diagnostics.length > 0 && <Disclosure title={copy.diagnostics(connection.scan.diagnostics.length)} open={false}><RepositoryDiagnostics label={copy.diagnosticSummary(connection.scan.diagnostics.length)} diagnostics={connection.scan.diagnostics} /></Disclosure>}
    </> : <Text roleName="muted">{copy.empty}</Text>}
    <>
      {busy && state.operation && <Layout roleName="activity" aria-live="polite"><Text roleName="muted">{copy.phase[state.operation]}</Text></Layout>}
      {state.error && <Message danger title={copy.error} body={state.error} action={<Button onClick={service.retry}>{copy.retry}</Button>} />}
      {local.available ? <Button variant="outline" disabled={busy} onClick={service.pickLocal}>{copy.local}</Button> : <Text roleName="muted">{local.reason}</Text>}
      {git.available ? <><InspectorField id="repository-owner" label={copy.owner} value={owner} onChange={setOwner} /><InspectorField id="repository-name" label={copy.name} value={name} onChange={setName} /><Button variant="outline" disabled={!canClone} onClick={() => service.cloneGitHub(owner.trim(), name.trim())}>{copy.clone}</Button></> : <Text roleName="muted">{git.reason}</Text>}
      {connection && <Button disabled={busy} onClick={service.rescan}>{copy.rescan}</Button>}
    </>
  </Layout>
}
