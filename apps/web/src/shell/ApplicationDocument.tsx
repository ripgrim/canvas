import type { ReactNode } from 'react'
import { HeadContent, Scripts, useRouterState } from '@tanstack/react-router'
import { DesktopAuthBoundary } from '@canvas/editor/auth'
import { appearanceKey, readAppearance } from '@canvas/editor/appearance'
import { FileLoadingPage } from '@canvas/editor/file'
import { AppTracking } from '../features/tracking/AppTracking'
import { ApplicationUpdateController } from '../features/updates/ApplicationUpdateController'
import '@canvas/editor/theme.css'
import '@canvas/editor/styles.css'

export function ApplicationDocument({ children }: { children: ReactNode }) {
  const appearance = readAppearance()
  const appearanceBootstrap = `try{document.documentElement.className=localStorage.getItem(${JSON.stringify(appearanceKey)})==='dark'?'theme-dark':'theme-light'}catch{document.documentElement.className='theme-light'}`
  return <html lang="en" className={`theme-${appearance}`} suppressHydrationWarning><head><HeadContent /><script dangerouslySetInnerHTML={{ __html: appearanceBootstrap }} /></head><body>{children}<ApplicationUpdateController /><AppTracking /><Scripts /></body></html>
}

export function ApplicationRouteContent({ children, pathname, status, resolvedLocation }: { children: ReactNode; pathname: string; status: string; resolvedLocation: unknown }) {
  const publicFileRoute = isPublicFileRoute(pathname)
  return publicFileRoute && status === 'pending' && resolvedLocation === undefined ? <FileLoadingPage /> : children
}

export const isPublicFileRoute = (pathname: string) => /^\/file\/[A-Za-z0-9_-]+\/?$/.test(pathname)

export function ApplicationShell({ children }: { children: ReactNode }) {
  const route = useRouterState({ select: state => ({ pathname: state.location.pathname, status: state.status, resolvedLocation: state.resolvedLocation }) })
  const publicFileRoute = isPublicFileRoute(route.pathname)
  return <ApplicationDocument><DesktopAuthBoundary allowSignedOut={publicFileRoute} loadingFallback={publicFileRoute ? <FileLoadingPage /> : undefined}><ApplicationRouteContent pathname={route.pathname} status={route.status} resolvedLocation={route.resolvedLocation}>{children}</ApplicationRouteContent></DesktopAuthBoundary></ApplicationDocument>
}
