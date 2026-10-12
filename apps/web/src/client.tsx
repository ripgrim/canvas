import { hydrateRoot } from 'react-dom/client'
import { StartClient } from '@tanstack/react-start/client'
import { prepareEditorUpdateRestart, startEditorServices } from '@canvas/editor/bootstrap'
import { createDesktopAdapter } from './adapters/desktop'
import type { DesktopBridge } from './adapters/desktop'
import { createBrowserAdapter } from './adapters/browser'
import { createCloudAdapter } from './adapters/cloud'
import '@canvas/editor/theme.css'
import '@canvas/editor/styles.css'
import { hostedAuthService } from './features/auth/hosted-auth-service'
import { applicationUpdateService } from './features/updates/application-update-service'

declare const __DESIGN_EDITOR_WEB_BUILD_ID__: string
declare const __DESIGN_EDITOR_APP_VERSION__: string

const bridge = (window as Window & { designEditor?: DesktopBridge }).designEditor
const previewOrigin = import.meta.env.DEV ? 'http://127.0.0.1:4318' : import.meta.env.VITE_PREVIEW_ORIGIN
const apiOrigin = import.meta.env.VITE_API_ORIGIN
const cloudAdapter = !bridge && apiOrigin
  ? createCloudAdapter({ apiOrigin, previewOrigin, editorOrigin: window.location.origin, assetsOrigin: import.meta.env.VITE_ASSETS_ORIGIN, loginOrigin: import.meta.env.VITE_LOGIN_ORIGIN, syncBuildId: import.meta.env.VITE_COLLABORATION_BUILD_ID })
  : null
const api = bridge
  ? createDesktopAdapter(bridge)
  : cloudAdapter ?? createBrowserAdapter(window.localStorage, previewOrigin, window.location.origin, navigator.locks)
const stop = startEditorServices(api)
if (bridge?.getUpdateSnapshot) applicationUpdateService.configureDesktop(bridge, prepareEditorUpdateRestart)
else if (import.meta.env.PROD) applicationUpdateService.configureWeb({
  buildId: __DESIGN_EDITOR_WEB_BUILD_ID__,
  version: __DESIGN_EDITOR_APP_VERSION__,
  fetchManifest: async () => {
    const response = await fetch('/version.json', { cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok) throw new Error(`Update manifest returned ${response.status}.`)
    return response.json()
  },
  reload: () => window.location.reload(),
  now: () => Date.now(),
  setTimeout: window.setTimeout.bind(window),
  clearTimeout: handle => window.clearTimeout(handle as number),
  addWindowListener: (type, listener) => window.addEventListener(type, listener),
  removeWindowListener: (type, listener) => window.removeEventListener(type, listener),
})
applicationUpdateService.start()
hostedAuthService.start()
const root = hydrateRoot(document, <StartClient />)
let disposed = false
const dispose = () => { if (disposed) return; disposed = true; window.removeEventListener('pagehide', onPageHide); applicationUpdateService.stop(); hostedAuthService.stop(); stop(); cloudAdapter?.dispose(); root.unmount() }
const onPageHide = (event: PageTransitionEvent) => { if (!event.persisted) dispose() }
window.addEventListener('pagehide', onPageHide)
import.meta.hot?.dispose(dispose)
