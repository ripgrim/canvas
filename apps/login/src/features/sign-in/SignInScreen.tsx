import { useSyncExternalStore } from 'react'
import { useTrackedClick } from '@canvas/tracking/react'
import { hostedLoginService } from './hosted-login-service'
import { LoginComponent } from './LoginComponent'

export { LoginComponent as SignInView } from './LoginComponent'

export function SignInScreen() {
  const state = useSyncExternalStore(hostedLoginService.subscribe, hostedLoginService.getSnapshot, hostedLoginService.getSnapshot)
  const onGitHub = useTrackedClick<HTMLButtonElement>('auth_provider_selected', () => void hostedLoginService.signIn(), { auth_provider: 'github' })
  return <LoginComponent state={state} onGitHub={onGitHub} />
}
