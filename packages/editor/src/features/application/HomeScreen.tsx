import { useSyncExternalStore } from 'react'
import { HomeView } from '../home/HomeView'
import { homeStore } from '../home/store'
import { authSessionService } from './auth-service'
import { applicationCopy as copy } from './application-copy'
import { trackCanvasEvent } from '@canvas/tracking'

export function displayDate(value: string | undefined, now = new Date()) {
  if (!value) return undefined
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) return undefined
  const elapsed = date.valueOf() - now.valueOf()
  const units = [{ limit: 60_000, divisor: 1_000, unit: 'second' }, { limit: 3_600_000, divisor: 60_000, unit: 'minute' }, { limit: 86_400_000, divisor: 3_600_000, unit: 'hour' }, { limit: 604_800_000, divisor: 86_400_000, unit: 'day' }] as const
  const absolute = Math.abs(elapsed)
  const match = units.find(candidate => absolute < candidate.limit)
  if (match) return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(elapsed / match.divisor), match.unit)
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}

export type HomeScreenProps = { onOpenFile: (fileId: string) => void; onCreateFile: (fileId: string) => void }

/** The project list is the application entry point in every runtime. */
export function HomeScreen({ onOpenFile, onCreateFile }: HomeScreenProps) {
  const state = useSyncExternalStore(homeStore.subscribe, homeStore.getSnapshot, homeStore.getSnapshot)
  const auth = useSyncExternalStore(authSessionService.subscribe, authSessionService.getSnapshot, authSessionService.getSnapshot)
  const capabilities = homeStore.capabilities()
  const files = state.files.map(file => {
    const { updatedAt: sourceDate, ...summary } = file
    const updatedAt = displayDate(sourceDate)
    return { ...summary, ...(updatedAt ? { updatedAt } : {}) }
  })
  const create = () => { void homeStore.create().then(fileId => { if (fileId) { trackCanvasEvent('file_created'); onCreateFile(fileId) } }) }
  return <HomeView mode={state.mode} workspaceName={copy.productName} accountName={auth.user?.name ?? copy.productName} files={files} status={state.status} create={capabilities.create} open={capabilities.open} onCreate={create} onOpen={onOpenFile} onRetry={homeStore.retry} onBack={homeStore.back} onToggleMode={homeStore.toggleMode} />
}
