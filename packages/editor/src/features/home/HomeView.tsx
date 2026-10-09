import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Button, Icon } from '../../design-system/atoms'
import { HomeBrand, HomeContent, HomeEmpty, HomeErrorPanel, HomeFileCard, HomeFileGrid, HomeHeader, HomeHeaderActions, HomeNote, HomePhaseList, HomeRoot, HomeSearch, HomeSection, HomeStatusScreen } from '../../design-system/home-atoms'
import { homeCopy as copy } from './home-copy'
import type { HomeFile, HomeStatus, HomeViewProps } from './home-types'

const searchId = 'home-file-search'

function errorTitle(status: Extract<HomeStatus, { kind: 'error' }>) {
  if (status.operation === 'list') return copy.listFailed
  if (status.operation === 'create') return copy.createFailed
  return status.fileName ? copy.openFailed(status.fileName) : copy.openFailedUnnamed
}

function matches(file: HomeFile, query: string) {
  const needle = query.trim().toLocaleLowerCase()
  return !needle || file.name.toLocaleLowerCase().includes(needle) || file.location.toLocaleLowerCase().includes(needle)
}

export function HomeView({ mode, workspaceName, files, status, create, open, onCreate, onOpen, onRetry, onBack, onToggleMode }: HomeViewProps) {
  const [query, setQuery] = useState('')
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      const search = event.currentTarget.querySelector<HTMLInputElement>(`#${searchId}`)
      if (search) { event.preventDefault(); search.focus() }
    }
  }
  const header = <HomeHeader><HomeBrand name={workspaceName} />{onToggleMode && <HomeHeaderActions><Button label={mode === 'light' ? copy.themeDark : copy.themeLight} onClick={onToggleMode}><Icon name={mode === 'light' ? 'moon' : 'sun'} /></Button></HomeHeaderActions>}</HomeHeader>

  if (status.kind === 'starting' || status.kind === 'creating' || status.kind === 'opening') {
    const title = status.kind === 'starting' ? copy.starting : status.kind === 'creating' ? copy.creatingFile : copy.opening(status.fileName)
    return <HomeRoot mode={mode} label={copy.label}>{status.kind !== 'starting' && header}<HomeStatusScreen title={title}>{status.phases.length > 0 && <HomePhaseList label={copy.phases} phases={status.phases} />}</HomeStatusScreen></HomeRoot>
  }

  const listFailed = status.kind === 'error' && status.operation === 'list'
  const visible = files.filter(file => matches(file, query))
  const newFile = <Button variant="primary" disabled={!create.available} title={create.available ? copy.newFile : create.reason} onClick={onCreate}><Icon name="plus" />{copy.newFile}</Button>
  const retryActions = <><Button variant="primary" onClick={onRetry}>{copy.retry}</Button>{onBack && status.kind === 'error' && status.operation !== 'list' && <Button variant="outline" onClick={onBack}>{copy.back}</Button>}</>
  const actions = files.length > 0 ? <><HomeSearch id={searchId} label={copy.search} value={query} onChange={setQuery} />{newFile}</> : undefined

  return <HomeRoot mode={mode} label={copy.label} onKeyDown={onKeyDown}>{header}<HomeContent>
    {status.kind === 'error' && !listFailed && <HomeErrorPanel title={errorTitle(status)} body={status.message} actions={retryActions} />}
    <HomeSection title={copy.files} actions={listFailed ? undefined : actions}>
      {listFailed ? <HomeErrorPanel title={errorTitle(status)} body={status.message} actions={retryActions} />
        : files.length === 0 ? <HomeEmpty title={copy.emptyTitle} body={copy.emptyBody} action={newFile} />
        : visible.length === 0 ? <HomeNote>{copy.noMatches(query.trim())}</HomeNote>
        : <HomeFileGrid label={copy.files}>{visible.map(file => <HomeFileCard key={file.id} name={file.name} detail={file.location} meta={file.updatedAt ? copy.updated(file.updatedAt) : undefined} openLabel={copy.open(file.name)} disabled={!open.available} onOpen={() => onOpen(file.id)} />)}</HomeFileGrid>}
      {!listFailed && !create.available && <HomeNote>{create.reason}</HomeNote>}
      {!listFailed && files.length > 0 && !open.available && <HomeNote>{open.reason}</HomeNote>}
    </HomeSection>
  </HomeContent></HomeRoot>
}
