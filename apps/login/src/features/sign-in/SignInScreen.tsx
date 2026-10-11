import { useSyncExternalStore } from 'react'
import type { MouseEventHandler } from 'react'
import { GitHubIcon, GoogleIcon, LoginActions, LoginBrand, LoginButton, LoginCard, LoginCenter, LoginError, LoginErrorReference, LoginProviderNote, LoginRoot, LoginStatus, LoginText, LoginTitle } from '../../design-system/auth-atoms'
import { hostedLoginService } from './hosted-login-service'
import type { HostedLoginSnapshot } from './hosted-login-service'
import { useTrackedClick } from '@canvas/tracking/react'

const copy = Object.freeze({
  title: 'Sign in',
  github: 'Continue with GitHub',
  google: 'Continue with Google',
  googleUnavailable: 'Google sign-in is not configured.',
  opening: 'Opening Canvas…',
  openingBody: 'You can close this tab after Canvas opens.',
})

export function SignInView({ state, onGitHub, onGoogle }: { state: HostedLoginSnapshot; onGitHub: MouseEventHandler<HTMLButtonElement>; onGoogle?: MouseEventHandler<HTMLButtonElement> | undefined }) {
  if (state.phase === 'opening') return <LoginRoot label={copy.opening}><LoginCenter><LoginBrand /><LoginStatus><LoginTitle>{copy.opening}</LoginTitle><LoginText>{copy.openingBody}</LoginText></LoginStatus></LoginCenter></LoginRoot>
  const disabled = state.phase === 'submitting' || state.invalidDesktopRequest
  return <LoginRoot label={copy.title}><LoginCenter><LoginBrand /><LoginTitle>{copy.title}</LoginTitle><LoginCard>{state.error && <LoginError>{state.error}</LoginError>}{state.errorReference && <LoginErrorReference>Error ID {state.errorReference}</LoginErrorReference>}<LoginActions><LoginButton className="login-button-google" disabled={disabled || !onGoogle} aria-describedby={!onGoogle ? 'google-provider-note' : undefined} onClick={onGoogle}><GoogleIcon />{copy.google}</LoginButton>{!onGoogle && <LoginProviderNote id="google-provider-note">{copy.googleUnavailable}</LoginProviderNote>}<LoginButton disabled={disabled} onClick={onGitHub}><GitHubIcon />{copy.github}</LoginButton></LoginActions></LoginCard></LoginCenter></LoginRoot>
}

export function SignInScreen() {
  const state = useSyncExternalStore(hostedLoginService.subscribe, hostedLoginService.getSnapshot, hostedLoginService.getSnapshot)
  const onGitHub = useTrackedClick<HTMLButtonElement>('auth_provider_selected', () => void hostedLoginService.signIn(), { auth_provider: 'github' })
  return <SignInView state={state} onGitHub={onGitHub} />
}
