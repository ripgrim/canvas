import { useSyncExternalStore } from 'react'
import { Button } from '../../design-system/atoms'
import { HomeContent, HomeErrorPanel, HomeMain, HomeRoot, HomeStatusScreen, HomeToolbar } from '../../design-system/home-atoms'
import { Editor } from '../editor/Editor'
import type { FileLocationResult } from '../editor/store'
import { editorStore } from '../editor/store'
import { homeStore } from '../home/store'
import { applicationCopy as copy } from './application-copy'

export type FileScreenProps = { result: FileLocationResult; onHome: () => void; onPageChange: (pageId: string) => void; onOpenDefaultPage: () => void }

/** Shell for a file route: the loaded editor, or an honest recovery state that never creates or substitutes a file. */
export function FileScreen({ result, onHome, onPageChange, onOpenDefaultPage }: FileScreenProps) {
  const mode = useSyncExternalStore(editorStore.subscribe, () => editorStore.getSnapshot().mode, () => editorStore.getSnapshot().mode)
  if (result.status === 'ok' || result.status === 'stale') return <Editor onHome={onHome} onPageChange={onPageChange} />
  const header = <HomeToolbar title={copy.productName} actions={null} />
  const back = <Button variant="primary" onClick={onHome}>{copy.backToFiles}</Button>
  if (result.status === 'missing-page') return <HomeRoot mode={mode} label={copy.fileLabel}><HomeMain>{header}<HomeContent><HomeErrorPanel title={copy.missingPageTitle(result.fileName)} body={copy.missingPageBody} actions={<><Button variant="primary" onClick={onOpenDefaultPage}>{copy.openDefaultPage}</Button>{back}</>} /></HomeContent></HomeMain></HomeRoot>
  if (result.status === 'missing-file') return <HomeRoot mode={mode} label={copy.fileLabel}><HomeMain>{header}<HomeContent><HomeErrorPanel title={copy.missingFileTitle} body={copy.missingFileBody(result.fileId)} actions={back} /></HomeContent></HomeMain></HomeRoot>
  if (result.status === 'unavailable') return <HomeRoot mode={mode} label={copy.fileLabel}><HomeMain>{header}<HomeContent><HomeErrorPanel title={copy.unavailableTitle} body={result.reason} actions={back} /></HomeContent></HomeMain></HomeRoot>
  return <HomeRoot mode={mode} label={copy.fileLabel}><HomeMain>{header}<HomeContent><HomeErrorPanel title={copy.errorTitle} body={result.message} {...(result.reference ? { reference: copy.errorReference(result.reference) } : {})} actions={back} /></HomeContent></HomeMain></HomeRoot>
}

export function FileLoading() {
  const mode = useSyncExternalStore(homeStore.subscribe, () => homeStore.getSnapshot().mode, () => homeStore.getSnapshot().mode)
  return <HomeRoot mode={mode} label={copy.fileLabel}><HomeStatusScreen title={copy.openingFile} /></HomeRoot>
}
