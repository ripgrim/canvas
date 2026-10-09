import { hydrateRoot } from 'react-dom/client'
import { StartClient } from '@tanstack/react-start/client'
import { startEditorServices } from '@canvas/editor/bootstrap'
import { createDesktopAdapter } from './adapters/desktop'
import type { DesktopBridge } from './adapters/desktop'
import { createBrowserAdapter } from './adapters/browser'
import '@canvas/editor/theme.css'
import '@canvas/editor/styles.css'

const bridge = (window as Window & { designEditor?: DesktopBridge }).designEditor
const api = bridge ? createDesktopAdapter(bridge) : createBrowserAdapter(window.localStorage, import.meta.env.DEV ? 'http://127.0.0.1:4318' : import.meta.env.VITE_PREVIEW_ORIGIN, window.location.origin, navigator.locks)
const stop = startEditorServices(api)
const root = hydrateRoot(document, <StartClient />)
let disposed = false
const dispose = () => { if (disposed) return; disposed = true; window.removeEventListener('pagehide', onPageHide); stop(); root.unmount() }
const onPageHide = (event: PageTransitionEvent) => { if (!event.persisted) dispose() }
window.addEventListener('pagehide', onPageHide)
import.meta.hot?.dispose(dispose)
