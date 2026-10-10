import { createFileRoute } from '@tanstack/react-router'
import { HostedSignInRoute } from '../shell/HostedSignInRoute'
import type { HostedSignInSearch } from '../shell/HostedSignInRoute'

function searchValue(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }

export const Route = createFileRoute('/sign-in')({
  validateSearch: (search): HostedSignInSearch => {
    const clientId = searchValue(search.client_id)
    const state = searchValue(search.state)
    const codeChallenge = searchValue(search.code_challenge)
    const error = searchValue(search.error)
    return { ...(clientId ? { client_id: clientId } : {}), ...(state ? { state } : {}), ...(codeChallenge ? { code_challenge: codeChallenge } : {}), ...(error ? { error } : {}) }
  },
  component: SignIn,
  ssr: false,
})

function SignIn() { return <HostedSignInRoute /> }
