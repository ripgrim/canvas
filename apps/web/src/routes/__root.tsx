import { createRootRoute, Outlet } from '@tanstack/react-router'
import { ApplicationDocument } from '../shell/ApplicationDocument'
import { appCopy } from '../shell/copy'
import { DesktopAuthBoundary } from '@canvas/editor/auth'

export const Route = createRootRoute({ head: () => ({ meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: appCopy.title }] }), component: ApplicationRoot })
function ApplicationRoot() { return <ApplicationDocument><DesktopAuthBoundary><Outlet /></DesktopAuthBoundary></ApplicationDocument> }
