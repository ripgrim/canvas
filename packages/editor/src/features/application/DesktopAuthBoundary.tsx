import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { AuthActions, AuthBody, AuthBrand, AuthCard, AuthCenter, AuthPrimaryAction, AuthRoot, AuthStatus, AuthTitle } from '../../design-system/auth-atoms'
import { authCopy } from './auth-copy'
import { authSessionService } from './auth-service'

function SignInPrompt({ message, retry }: { message?: string | null; retry?: boolean }) {
  return <AuthRoot label={authCopy.desktopTitle}><AuthCenter><AuthBrand label="Canvas" /><AuthTitle>{authCopy.desktopTitle}</AuthTitle><AuthCard><AuthBody>{message ?? authCopy.desktopBody}</AuthBody><AuthActions><AuthPrimaryAction onClick={authSessionService.signIn}>{retry ? authCopy.signInAgain : authCopy.signIn}</AuthPrimaryAction></AuthActions></AuthCard></AuthCenter></AuthRoot>
}

export function DesktopAuthBoundary({ children }: { children: ReactNode }) {
  const auth = useSyncExternalStore(authSessionService.subscribe, authSessionService.getSnapshot, authSessionService.getSnapshot)
  if (auth.status === 'signed-in' || (auth.status === 'unavailable' && authSessionService.allowsUnauthenticatedWorkspace())) return children
  if (auth.status === 'loading') return <AuthRoot label={authCopy.loading}><AuthCenter><AuthBrand label="Canvas" /><AuthStatus title={authCopy.loading} /></AuthCenter></AuthRoot>
  if (auth.status === 'signing-in') return <AuthRoot label={authCopy.signingIn}><AuthCenter><AuthBrand label="Canvas" /><AuthStatus title={authCopy.signingIn} body={authCopy.browserBody} /></AuthCenter></AuthRoot>
  if (auth.status === 'authenticating') return <AuthRoot label={authCopy.finishing}><AuthCenter><AuthBrand label="Canvas" /><AuthStatus title={authCopy.finishing} /></AuthCenter></AuthRoot>
  if (auth.status === 'signed-out') return <SignInPrompt />
  return <SignInPrompt retry message={auth.message ?? authCopy.status(auth.status)} />
}
