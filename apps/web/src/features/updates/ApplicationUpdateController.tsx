import { useSyncExternalStore } from 'react'
import { ApplicationUpdateNotice } from '@canvas/editor/updates'
import { applicationUpdateService } from './application-update-service'

export function ApplicationUpdateController() {
  const snapshot = useSyncExternalStore(applicationUpdateService.subscribe, applicationUpdateService.getSnapshot, applicationUpdateService.getServerSnapshot)
  return <ApplicationUpdateNotice snapshot={snapshot} dismissedVersion={applicationUpdateService.getDismissedVersion()} onDismiss={() => applicationUpdateService.dismiss()} onCheck={() => void applicationUpdateService.check()} onDownload={() => void applicationUpdateService.download()} onInstall={() => void applicationUpdateService.install()} />
}
