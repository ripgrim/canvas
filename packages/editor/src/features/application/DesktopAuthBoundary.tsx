import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { AuthActions, AuthBody, AuthBrand, AuthCenter, AuthErrorReference, AuthPrimaryAction, AuthPrompt, AuthRoot, AuthStatus, AuthTitle } from '../../design-system/auth-atoms'
import { authCopy } from './auth-copy'
import { authSessionService } from './auth-service'
import { ApplicationStartup } from './ApplicationStartup'

function SignInPrompt({ message, reference, action = authSessionService.signIn, actionLabel = authCopy.signIn }: { message?: string | null; reference?: string | undefined; action?: () => void; actionLabel?: string }) {
  return <AuthRoot label={authCopy.desktopTitle}><AuthCenter><AuthBrand label="Canvas" /><AuthTitle>{authCopy.desktopTitle}</AuthTitle><AuthPrompt><AuthBody>{message ?? authCopy.desktopBody}</AuthBody>{reference && <AuthErrorReference>{authCopy.errorReference(reference)}</AuthErrorReference>}<AuthActions><AuthPrimaryAction onClick={action}>{actionLabel}</AuthPrimaryAction></AuthActions></AuthPrompt></AuthCenter></AuthRoot>
}

export function DesktopAuthBoundary({ children, allowSignedOut = false, loadingFallback }: { children: ReactNode; allowSignedOut?: boolean; loadingFallback?: ReactNode }) {
  const auth = useSyncExternalStore(authSessionService.subscribe, authSessionService.getSnapshot, authSessionService.getServerSnapshot)
  if (auth.status === 'signed-in' || (auth.status === 'signed-out' && allowSignedOut && authSessionService.allowsSignedOutWorkspace()) || (auth.status === 'unavailable' && authSessionService.allowsUnauthenticatedWorkspace())) return children
  if (auth.status === 'loading') return loadingFallback ?? <ApplicationStartup label={authCopy.loading} title={authCopy.loading} />
  if (auth.status === 'signing-in') return <AuthRoot label={authCopy.signingIn}><AuthCenter><AuthBrand label="Canvas" /><AuthStatus title={authCopy.signingIn} body={authCopy.browserBody} /></AuthCenter></AuthRoot>
  if (auth.status === 'authenticating') return <AuthRoot label={authCopy.finishing}><AuthCenter><AuthBrand label="Canvas" /><AuthStatus title={authCopy.finishing} /></AuthCenter></AuthRoot>
  if (auth.status === 'signed-out') return <SignInPrompt />
  if (auth.status === 'offline') return <SignInPrompt message={auth.message ?? authCopy.status(auth.status)} reference={auth.reference} action={authSessionService.retry} actionLabel={authCopy.tryAgain} />
  return <SignInPrompt message={auth.message ?? authCopy.status(auth.status)} reference={auth.reference} actionLabel={authCopy.signInAgain} />
}
