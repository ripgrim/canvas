import type { ReactNode } from 'react'
import { HeadContent, Scripts } from '@tanstack/react-router'
import { DesktopAuthBoundary } from '@canvas/editor/auth'
import { AppTracking } from '../features/tracking/AppTracking'
import { ApplicationUpdateController } from '../features/updates/ApplicationUpdateController'

export function ApplicationDocument({ children }: { children: ReactNode }) {
  return <html lang="en"><head><HeadContent /></head><body>{children}<ApplicationUpdateController /><AppTracking /><Scripts /></body></html>
}

export function ApplicationShell({ children }: { children: ReactNode }) {
  const publicFileRoute = typeof window !== 'undefined' && /^\/file\/[A-Za-z0-9_-]+\/?$/.test(window.location.pathname)
  return <ApplicationDocument><DesktopAuthBoundary allowSignedOut={publicFileRoute}>{children}</DesktopAuthBoundary></ApplicationDocument>
}
