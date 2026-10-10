import { useState } from 'react'
import type { DesktopSignInRequest } from '@canvas/auth'
import { AuthActions, AuthBody, AuthBrand, AuthCard, AuthCenter, AuthError, AuthGitHubAction, AuthRoot, AuthStatus, AuthTitle } from '../../design-system/auth-atoms'

const copy = {
  title: 'Sign in',
  github: 'Continue with GitHub',
  invalid: 'Start sign in from the Canvas desktop app.',
  opening: 'Opening Canvas…',
  openingBody: 'You can close this tab after Canvas opens.',
  failed: 'Sign-in could not start. Try again.',
} as const

export function HostedSignInScreen({ request, opening, providerError, onGitHub }: { request: DesktopSignInRequest | null; opening: boolean; providerError?: string | null; onGitHub: (request: DesktopSignInRequest) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(providerError ?? null)
  const signIn = () => {
    if (!request || busy) return
    setBusy(true)
    setError(null)
    void onGitHub(request).catch(() => { setBusy(false); setError(copy.failed) })
  }
  if (opening) return <AuthRoot label={copy.opening}><AuthCenter><AuthBrand label="Canvas" /><AuthStatus title={copy.opening} body={copy.openingBody} /></AuthCenter></AuthRoot>
  return <AuthRoot label={copy.title}><AuthCenter><AuthBrand label="Canvas" /><AuthTitle>{copy.title}</AuthTitle><AuthCard><AuthBody>{request ? 'Continue with your account.' : copy.invalid}</AuthBody>{error && <AuthError>{error}</AuthError>}{request && <AuthActions><AuthGitHubAction disabled={busy} onClick={signIn} /></AuthActions>}</AuthCard></AuthCenter></AuthRoot>
}
