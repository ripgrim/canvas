import { createRoot } from 'react-dom/client'
import { ApplicationUpdateNotice } from '@canvas/editor/updates'
import type { ApplicationUpdateSnapshot } from '@canvas/editor/updates'
import '@canvas/editor/theme.css'
import '@canvas/editor/styles.css'
import './fixture.css'

const phase = new URLSearchParams(location.search).get('phase') ?? 'ready'
const snapshot: ApplicationUpdateSnapshot = Object.freeze({ kind: 'desktop', channel: 'nightly', status: phase === 'downloading' ? 'downloading' : 'ready', currentVersion: '0.1.0-nightly.40', availableVersion: '0.1.0-nightly.41', progress: phase === 'downloading' ? 65 : 100, releaseNotes: 'Selection stays responsive while collaboration catches up.', checkedAt: new Date(0).toISOString(), message: null, reference: null, retryable: false })

createRoot(document.getElementById('root')!).render(<main className="theme-dark fixture-canvas"><div className="fixture-frame" /><ApplicationUpdateNotice snapshot={snapshot} dismissedVersion={null} onDismiss={() => undefined} onCheck={() => undefined} onDownload={() => undefined} onInstall={() => undefined} /></main>)
