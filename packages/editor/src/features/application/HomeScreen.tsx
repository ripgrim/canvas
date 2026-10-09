import { useSyncExternalStore } from 'react'
import { Editor } from '../editor/Editor'
import { HomeView } from '../home/HomeView'
import { homeStore } from '../home/store'
import { applicationCopy as copy } from './application-copy'

function displayDate(value: string | undefined) {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isFinite(date.valueOf()) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date) : undefined
}

export type HomeScreenProps = { onOpenFile: (fileId: string) => void; onCreateFile: (fileId: string) => void }

/** The file list. Without a file-listing capability (the desktop fixture shell) the single project opens directly. */
export function HomeScreen({ onOpenFile, onCreateFile }: HomeScreenProps) {
  const state = useSyncExternalStore(homeStore.subscribe, homeStore.getSnapshot, homeStore.getSnapshot)
  if (state.screen === 'editor') return <Editor />
  const capabilities = homeStore.capabilities()
  const files = state.files.map(file => {
    const { updatedAt: sourceDate, ...summary } = file
    const updatedAt = displayDate(sourceDate)
    return { ...summary, ...(updatedAt ? { updatedAt } : {}) }
  })
  const create = () => { void homeStore.create().then(fileId => { if (fileId) onCreateFile(fileId) }) }
  return <HomeView mode={state.mode} workspaceName={copy.productName} files={files} status={state.status} create={capabilities.create} open={capabilities.open} onCreate={create} onOpen={onOpenFile} onRetry={homeStore.retry} onBack={homeStore.back} onToggleMode={homeStore.toggleMode} />
}
