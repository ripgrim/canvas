import { useSyncExternalStore } from 'react'
import { HostedSignInScreen } from '@canvas/editor/auth'
import { hostedAuthService } from '../features/auth/hosted-auth-service'

export type HostedSignInSearch = Readonly<{
  client_id?: string
  state?: string
  code_challenge?: string
  error?: string
}>

export function HostedSignInRoute() {
  const state = useSyncExternalStore(hostedAuthService.subscribe, hostedAuthService.getSnapshot, hostedAuthService.getSnapshot)
  return <HostedSignInScreen request={state.request} opening={state.openingDesktop} providerError={state.providerError} onGitHub={hostedAuthService.signInWithGitHub} />
}
