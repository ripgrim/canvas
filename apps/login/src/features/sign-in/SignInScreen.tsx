import { useSyncExternalStore } from 'react'
import { GitHubIcon, LoginActions, LoginBrand, LoginButton, LoginCard, LoginCenter, LoginError, LoginRoot, LoginStatus, LoginText, LoginTitle } from '../../design-system/auth-atoms'
import { hostedLoginService } from './hosted-login-service'

const copy = Object.freeze({ title: 'Sign in to Canvas', continue: 'Continue with GitHub', opening: 'Opening Canvas…', openingBody: 'You can close this tab after Canvas opens.' })

export function SignInScreen() {
  const state = useSyncExternalStore(hostedLoginService.subscribe, hostedLoginService.getSnapshot, hostedLoginService.getSnapshot)
  if (state.phase === 'opening') return <LoginRoot label={copy.opening}><LoginCenter><LoginBrand /><LoginStatus><LoginTitle>{copy.opening}</LoginTitle><LoginText>{copy.openingBody}</LoginText></LoginStatus></LoginCenter></LoginRoot>
  return <LoginRoot label={copy.title}><LoginCenter><LoginBrand /><LoginTitle>{copy.title}</LoginTitle><LoginCard>{state.error && <LoginError>{state.error}</LoginError>}<LoginActions><LoginButton disabled={state.phase === 'submitting' || state.invalidDesktopRequest} onClick={() => void hostedLoginService.signIn()}><GitHubIcon />{copy.continue}</LoginButton></LoginActions></LoginCard></LoginCenter></LoginRoot>
}
