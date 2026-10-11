import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Button, Icon } from '../../design-system/atoms'
import { HomeContent, HomeEmpty, HomeErrorPanel, HomeFileCard, HomeFileGrid, HomeMain, HomeNote, HomePhaseList, HomeRoot, HomeSearch, HomeSection, HomeSidebar, HomeStatusScreen, HomeToolbar, HomeViewSwitch } from '../../design-system/home-atoms'
import type { HomeViewMode } from '../../design-system/home-atoms'
import { homeCopy as copy } from './home-copy'
import type { HomeFile, HomeStatus, HomeViewProps } from './home-types'

const searchId = 'home-file-search'

function errorTitle(status: Extract<HomeStatus, { kind: 'error' }>) {
  if (status.operation === 'list') return copy.listFailed
  if (status.operation === 'create') return copy.createFailed
  return status.fileName ? copy.openFailed(status.fileName) : copy.openFailedUnnamed
}

export function matchesHomeFile(file: HomeFile, query: string) {
  const needle = query.trim().toLocaleLowerCase()
  return !needle || file.name.toLocaleLowerCase().includes(needle) || file.location.toLocaleLowerCase().includes(needle)
}

export function filterHomeFiles(files: readonly HomeFile[], query: string) {
  return files.filter(file => matchesHomeFile(file, query))
}

export function HomeView({ mode, workspaceName, accountName, files, status, create, open, onCreate, onOpen, onRetry, onBack, onToggleMode }: HomeViewProps) {
  const [query, setQuery] = useState('')
  const [view, setView] = useState<HomeViewMode>('grid')
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      const search = event.currentTarget.querySelector<HTMLInputElement>(`#${searchId}`)
      if (search) { event.preventDefault(); search.focus() }
    }
  }
  const search = <HomeSearch id={searchId} label={copy.search} value={query} onChange={setQuery} />
  const theme = onToggleMode ? <Button label={mode === 'light' ? copy.themeDark : copy.themeLight} onClick={onToggleMode}><Icon name={mode === 'light' ? 'moon' : 'sun'} />{workspaceName}</Button> : undefined
  const sidebar = <HomeSidebar accountName={accountName} search={search} current={copy.files} footer={theme} />
  const visible = filterHomeFiles(files, query)
  const busy = status.kind === 'creating' || status.kind === 'opening'
  const newFile = <Button variant="outline" disabled={!create.available || busy} title={create.available ? copy.newFile : create.reason} onClick={onCreate}><Icon name="plus" />{copy.newFile}</Button>
  const toolbar = <HomeToolbar title={copy.files} actions={<>{newFile}<HomeViewSwitch value={view} gridLabel={copy.gridView} listLabel={copy.listView} onChange={setView} /></>} />

  if (status.kind === 'starting' || status.kind === 'creating' || status.kind === 'opening') {
    const title = status.kind === 'starting' ? copy.starting : status.kind === 'creating' ? copy.creatingFile : copy.opening(status.fileName)
    return <HomeRoot mode={mode} label={copy.label}>{sidebar}<HomeMain>{toolbar}<HomeStatusScreen title={title}>{status.phases.length > 0 && <HomePhaseList label={copy.phases} phases={status.phases} />}</HomeStatusScreen></HomeMain></HomeRoot>
  }

  const listFailed = status.kind === 'error' && status.operation === 'list'
  const retryActions = <><Button variant="primary" onClick={onRetry}>{copy.retry}</Button>{onBack && status.kind === 'error' && status.operation !== 'list' && <Button variant="outline" onClick={onBack}>{copy.back}</Button>}</>

  return <HomeRoot mode={mode} label={copy.label} onKeyDown={onKeyDown}>{sidebar}<HomeMain>{toolbar}<HomeContent>
    {status.kind === 'error' && !listFailed && <HomeErrorPanel title={errorTitle(status)} body={status.message} reference={copy.errorReference(status.reference)} actions={retryActions} />}
    <HomeSection title={copy.files}>
      {listFailed ? <HomeErrorPanel title={errorTitle(status)} body={status.message} reference={copy.errorReference(status.reference)} actions={retryActions} />
        : files.length === 0 ? <HomeEmpty title={copy.emptyTitle} />
        : visible.length === 0 ? <HomeNote>{copy.noMatches}</HomeNote>
        : <HomeFileGrid label={copy.files} mode={view}>{visible.map(file => <HomeFileCard key={file.id} name={file.name} meta={file.updatedAt ? copy.updated(file.updatedAt) : undefined} thumbnailUrl={file.thumbnailUrl} openLabel={copy.open(file.name)} disabled={!open.available} onOpen={() => onOpen(file.id)} />)}</HomeFileGrid>}
    </HomeSection>
  </HomeContent></HomeMain></HomeRoot>
}
