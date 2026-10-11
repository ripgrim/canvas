import { useState } from 'react'
import type { DesktopSignInRequest } from '@canvas/auth'
import { AuthActions, AuthBrand, AuthCard, AuthCenter, AuthError, AuthErrorReference, AuthGitHubAction, AuthRoot, AuthStatus, AuthTitle } from '../../design-system/auth-atoms'
import { failureDetails } from './failure'
import { trackCanvasEvent } from '@canvas/tracking'

const copy = {
  title: 'Sign in',
  github: 'Continue with GitHub',
  invalid: 'Start sign in from the Canvas desktop app.',
  opening: 'Opening Canvas…',
  openingBody: 'You can close this tab after Canvas opens.',
  failed: 'Sign-in could not start. Try again.',
  errorReference: (reference: string) => `Error ID ${reference}`,
} as const

export function HostedSignInScreen({ request, opening, providerError, providerErrorReference, onGitHub }: { request: DesktopSignInRequest | null; opening: boolean; providerError?: string | null; providerErrorReference?: string | null; onGitHub: (request: DesktopSignInRequest) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(providerError ?? null)
  const [reference, setReference] = useState<string | null>(providerErrorReference ?? null)
  const signIn = () => {
    if (!request || busy) return
    setBusy(true)
    setError(null)
    setReference(null)
    void onGitHub(request).catch(reason => {
      const failure = failureDetails(reason, copy.failed)
      trackCanvasEvent('operation_failed', { operation: 'auth_sign_in', error_code: failure.code, error_reference: failure.reference })
      setBusy(false)
      setError(failure.message)
      setReference(failure.reference)
    })
  }
  if (opening) return <AuthRoot label={copy.opening}><AuthCenter><AuthBrand label="Canvas" /><AuthStatus title={copy.opening} body={copy.openingBody} /></AuthCenter></AuthRoot>
  return <AuthRoot label={copy.title}><AuthCenter><AuthBrand label="Canvas" /><AuthTitle>{copy.title}</AuthTitle><AuthCard>{!request && <AuthError>{copy.invalid}</AuthError>}{error && <AuthError>{error}</AuthError>}{reference && <AuthErrorReference>{copy.errorReference(reference)}</AuthErrorReference>}{request && <AuthActions><AuthGitHubAction disabled={busy} onClick={signIn} /></AuthActions>}</AuthCard></AuthCenter></AuthRoot>
}
