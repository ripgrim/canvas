import { hydrateRoot } from 'react-dom/client'
import { StartClient } from '@tanstack/react-start/client'
import { startEditorServices } from '@canvas/editor/bootstrap'
import { createDesktopAdapter } from './adapters/desktop'
import type { DesktopBridge } from './adapters/desktop'
import { createBrowserAdapter } from './adapters/browser'
import { createCloudAdapter } from './adapters/cloud'
import '@canvas/editor/theme.css'
import '@canvas/editor/styles.css'
import { hostedAuthService } from './features/auth/hosted-auth-service'

const bridge = (window as Window & { designEditor?: DesktopBridge }).designEditor
const previewOrigin = import.meta.env.DEV ? 'http://127.0.0.1:4318' : import.meta.env.VITE_PREVIEW_ORIGIN
const apiOrigin = import.meta.env.VITE_API_ORIGIN
const cloudAdapter = !bridge && apiOrigin
  ? createCloudAdapter({ apiOrigin, previewOrigin, editorOrigin: window.location.origin, assetsOrigin: import.meta.env.VITE_ASSETS_ORIGIN, loginOrigin: import.meta.env.VITE_LOGIN_ORIGIN })
  : null
const api = bridge
  ? createDesktopAdapter(bridge)
  : cloudAdapter ?? createBrowserAdapter(window.localStorage, previewOrigin, window.location.origin, navigator.locks)
const stop = startEditorServices(api)
hostedAuthService.start()
const root = hydrateRoot(document, <StartClient />)
let disposed = false
const dispose = () => { if (disposed) return; disposed = true; window.removeEventListener('pagehide', onPageHide); hostedAuthService.stop(); stop(); cloudAdapter?.dispose(); root.unmount() }
const onPageHide = (event: PageTransitionEvent) => { if (!event.persisted) dispose() }
window.addEventListener('pagehide', onPageHide)
import.meta.hot?.dispose(dispose)
