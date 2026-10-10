import type { AuthStatus } from '@canvas/auth'

export const authCopy = {
  account: 'Account',
  signIn: 'Sign in',
  signingIn: 'Signing in…',
  loading: 'Checking your session…',
  finishing: 'Finishing sign in…',
  desktopTitle: 'Sign in to Canvas',
  desktopBody: 'Please sign in with your browser to continue.',
  browserBody: 'Finish signing in in your browser.',
  signInAgain: 'Sign in again',
  signOut: 'Sign out',
  github: 'Continue with GitHub',
  unavailable: 'Account sign-in is not configured for this build.',
  status: (status: AuthStatus) => status === 'callback-expired' ? 'The sign-in link expired.' : status === 'denied' ? 'GitHub sign-in was denied.' : status === 'offline' ? 'The auth service is offline.' : status === 'revoked' ? 'Your session was revoked.' : 'Sign-in could not finish.',
} as const
