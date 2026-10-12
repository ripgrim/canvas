import type { ApplicationUpdateSnapshot } from './update-types'
import { Button } from '../../design-system/atoms'
import { UpdateCard, UpdateRegion } from '../../design-system/update-atoms'

const copy = Object.freeze({
  available: (version: string) => `Version ${version} is available`,
  downloading: (version: string) => `Downloading version ${version}`,
  readyDesktop: 'Restart Comp Canvas to finish the update.',
  readyWeb: 'Refresh Comp Canvas to use the latest version.',
  failed: 'Update check failed',
  download: 'Download',
  restart: 'Restart',
  refresh: 'Refresh',
  retry: 'Try again',
  progress: 'Update download progress',
  dismiss: 'Dismiss update notice',
})

export function ApplicationUpdateNotice({ snapshot, dismissedVersion, onDismiss, onCheck, onDownload, onInstall }: { snapshot: ApplicationUpdateSnapshot; dismissedVersion: string | null; onDismiss: () => void; onCheck: () => void; onDownload: () => void; onInstall: () => void }) {
  if (!['available', 'downloading', 'ready', 'error'].includes(snapshot.status)) return null
  if (snapshot.availableVersion && snapshot.availableVersion === dismissedVersion && snapshot.status !== 'error') return null
  const version = snapshot.availableVersion ?? snapshot.currentVersion
  const labels = { progressLabel: copy.progress, dismissLabel: copy.dismiss }
  if (snapshot.status === 'available') return <UpdateRegion><UpdateCard {...labels} title={copy.available(version)} description={snapshot.releaseNotes ?? 'Download now and restart when you are ready.'} action={<Button variant="primary" onClick={onDownload}>{copy.download}</Button>} onDismiss={onDismiss} /></UpdateRegion>
  if (snapshot.status === 'downloading') return <UpdateRegion><UpdateCard {...labels} title={copy.downloading(version)} description="You can keep working while the update downloads." progress={snapshot.progress} onDismiss={onDismiss} /></UpdateRegion>
  if (snapshot.status === 'ready') return <UpdateRegion><UpdateCard {...labels} title={copy.available(version)} description={snapshot.kind === 'desktop' ? copy.readyDesktop : copy.readyWeb} action={<Button variant="primary" onClick={onInstall}>{snapshot.kind === 'desktop' ? copy.restart : copy.refresh}</Button>} onDismiss={onDismiss} /></UpdateRegion>
  return <UpdateRegion><UpdateCard {...labels} title={copy.failed} description={[snapshot.message, snapshot.reference ? `Reference: ${snapshot.reference}` : null].filter(Boolean).join(' ')} action={snapshot.retryable ? <Button variant="primary" onClick={onCheck}>{copy.retry}</Button> : undefined} onDismiss={onDismiss} /></UpdateRegion>
}
