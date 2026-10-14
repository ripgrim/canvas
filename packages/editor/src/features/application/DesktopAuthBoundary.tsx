import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { AuthActions, AuthBody, AuthBrand, AuthCenter, AuthErrorReference, AuthPrimaryAction, AuthPrompt, AuthRoot, AuthStatus, AuthTitle } from '../../design-system/auth-atoms'
import { authCopy } from './auth-copy'
import { authSessionService } from './auth-service'

function SignInPrompt({ message, reference, retry }: { message?: string | null; reference?: string | undefined; retry?: boolean }) {
  return <AuthRoot label={authCopy.desktopTitle}><AuthCenter><AuthBrand label="Canvas" /><AuthTitle>{authCopy.desktopTitle}</AuthTitle><AuthPrompt><AuthBody>{message ?? authCopy.desktopBody}</AuthBody>{reference && <AuthErrorReference>{authCopy.errorReference(reference)}</AuthErrorReference>}<AuthActions><AuthPrimaryAction onClick={authSessionService.signIn}>{retry ? authCopy.signInAgain : authCopy.signIn}</AuthPrimaryAction></AuthActions></AuthPrompt></AuthCenter></AuthRoot>
}

export function DesktopAuthBoundary({ children, allowSignedOut = false }: { children: ReactNode; allowSignedOut?: boolean }) {
  const auth = useSyncExternalStore(authSessionService.subscribe, authSessionService.getSnapshot, authSessionService.getServerSnapshot)
  if (auth.status === 'signed-in' || (auth.status === 'signed-out' && allowSignedOut && authSessionService.allowsSignedOutWorkspace()) || (auth.status === 'unavailable' && authSessionService.allowsUnauthenticatedWorkspace())) return children
  if (auth.status === 'loading') return <AuthRoot label={authCopy.loading}><AuthCenter><AuthBrand label="Canvas" /><AuthStatus title={authCopy.loading} /></AuthCenter></AuthRoot>
  if (auth.status === 'signing-in') return <AuthRoot label={authCopy.signingIn}><AuthCenter><AuthBrand label="Canvas" /><AuthStatus title={authCopy.signingIn} body={authCopy.browserBody} /></AuthCenter></AuthRoot>
  if (auth.status === 'authenticating') return <AuthRoot label={authCopy.finishing}><AuthCenter><AuthBrand label="Canvas" /><AuthStatus title={authCopy.finishing} /></AuthCenter></AuthRoot>
  if (auth.status === 'signed-out') return <SignInPrompt />
  return <SignInPrompt retry message={auth.message ?? authCopy.status(auth.status)} reference={auth.reference} />
}
