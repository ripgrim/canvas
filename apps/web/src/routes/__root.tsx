import { createRootRoute, Outlet } from '@tanstack/react-router'
import { ApplicationShell } from '../shell/ApplicationDocument'
import { appCopy } from '../shell/copy'

export const Route = createRootRoute({ head: () => ({ meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: appCopy.title }] }), component: ApplicationRoot })
function ApplicationRoot() { return <ApplicationShell><Outlet /></ApplicationShell> }
