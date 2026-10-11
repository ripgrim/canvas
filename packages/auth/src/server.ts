import { electron } from '@better-auth/electron'
import { betterAuth } from 'better-auth'
import type { BetterAuthOptions } from 'better-auth'
import { isIP } from 'node:net'
import { desktopAuthClientId, desktopAuthProtocolScheme } from './index.js'

export type HostedAuthOptions = Readonly<{
  database: NonNullable<BetterAuthOptions['database']>
  baseURL: string
  secret: string
  githubClientId: string
  githubClientSecret: string
  desktopScheme: string
  desktopClientId?: string
  trustedOrigins?: readonly string[]
  cookieDomain?: string
}>

export type HostedSessionUser = Readonly<{ id: string; name: string; email: string; image: string | null }>
export type HostedAuth = Readonly<{
  handler(request: Request): Promise<Response>
  getSession(request: Request): Promise<HostedSessionUser | null>
}>

type HostedAuthEnvironment = Readonly<Record<string, string | undefined>>

function requiredEnvironment(environment: HostedAuthEnvironment, name: string): string {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`Missing ${name}.`)
  return value
}

function webOrigin(value: string, label: string, allowLoopbackHttp = true): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`${label} must be an HTTP or HTTPS origin.`) }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (!['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && (!local || !allowLoopbackHttp)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label} must be an HTTPS origin outside local development.`)
  }
  return url.origin
}

function domainContainsHostname(domain: string, hostname: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

function sharedCookieDomain(value: string | undefined, baseURL: string): string | undefined {
  const candidate = value?.trim().toLowerCase()
  if (!candidate) return undefined
  const domain = candidate.startsWith('.') ? candidate.slice(1) : candidate
  const labels = domain.split('.')
  if (domain.length > 253 || labels.some(label => label.length > 63) || isIP(domain) !== 0 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw new Error('AUTH_COOKIE_DOMAIN must be a parent DNS domain, not localhost or an IP address.')
  }
  const hostname = new URL(baseURL).hostname.toLowerCase()
  if (!domainContainsHostname(domain, hostname)) throw new Error('AUTH_COOKIE_DOMAIN must contain the Better Auth host.')
  return `.${domain}`
}

function trustedWebOrigins(values: readonly string[], baseURL: string, cookieDomain?: string): readonly string[] {
  const base = new URL(baseURL)
  const allowLoopbackHttp = base.protocol === 'http:'
  const domain = cookieDomain?.slice(1)
  const origins = values
    .map(origin => webOrigin(origin, 'Trusted auth origin', allowLoopbackHttp))
  if (domain && origins.some(origin => !domainContainsHostname(domain, new URL(origin).hostname.toLowerCase()))) {
    throw new Error('Trusted auth origins must be contained by AUTH_COOKIE_DOMAIN when cross-subdomain cookies are enabled.')
  }
  return [...new Set(origins)]
}

export function hostedAuthOptionsFromEnvironment(environment: HostedAuthEnvironment, database: HostedAuthOptions['database']): HostedAuthOptions {
  const baseURL = webOrigin(requiredEnvironment(environment, 'BETTER_AUTH_URL'), 'Better Auth URL')
  const cookieDomain = sharedCookieDomain(environment.AUTH_COOKIE_DOMAIN, baseURL)
  const trustedOrigins = trustedWebOrigins([environment.LOGIN_URL, environment.APP_URL, environment.AUTH_TRUSTED_ORIGINS]
    .flatMap(value => value?.split(',') ?? [])
    .map(origin => origin.trim())
    .filter(Boolean), baseURL, cookieDomain)
  return {
    database,
    baseURL,
    secret: requiredEnvironment(environment, 'BETTER_AUTH_SECRET'),
    githubClientId: requiredEnvironment(environment, 'GITHUB_CLIENT_ID'),
    githubClientSecret: requiredEnvironment(environment, 'GITHUB_CLIENT_SECRET'),
    desktopScheme: desktopAuthProtocolScheme,
    desktopClientId: desktopAuthClientId,
    ...(cookieDomain ? { cookieDomain } : {}),
    ...(trustedOrigins?.length ? { trustedOrigins } : {}),
  }
}

export function databaseURLFromEnvironment(environment: HostedAuthEnvironment): string {
  const raw = requiredEnvironment(environment, 'DATABASE_URL')
  const url = new URL(raw)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.')
  return url.toString()
}

export function createHostedAuth(options: HostedAuthOptions): HostedAuth {
  const canonicalBaseURL = webOrigin(options.baseURL, 'Auth base URL')
  const baseURL = new URL(canonicalBaseURL)
  const cookieDomain = sharedCookieDomain(options.cookieDomain, canonicalBaseURL)
  const trustedOrigins = trustedWebOrigins(options.trustedOrigins ?? [], canonicalBaseURL, cookieDomain)
  const crossSiteCookie = baseURL.protocol === 'https:' && !cookieDomain && trustedOrigins.some(origin => new URL(origin).hostname !== baseURL.hostname)
  if (options.secret.length < 32) throw new Error('Better Auth secret must contain at least 32 characters.')
  if (!options.githubClientId.trim() || !options.githubClientSecret.trim()) throw new Error('GitHub OAuth credentials are required.')
  if (!/^[a-z][a-z0-9+.-]{2,63}$/.test(options.desktopScheme)) throw new Error('Invalid desktop auth scheme.')
  const auth = betterAuth({
    database: options.database,
    baseURL: baseURL.toString().replace(/\/$/, ''),
    secret: options.secret,
    trustedOrigins: [`${options.desktopScheme}:/`, ...trustedOrigins],
    advanced: {
      useSecureCookies: baseURL.protocol === 'https:',
      defaultCookieAttributes: { httpOnly: true, secure: baseURL.protocol === 'https:', sameSite: crossSiteCookie ? 'none' : 'lax', path: '/' },
      ...(cookieDomain ? { crossSubDomainCookies: { enabled: true, domain: cookieDomain } } : {}),
    },
    socialProviders: {
      github: {
        clientId: options.githubClientId,
        clientSecret: options.githubClientSecret,
      },
    },
    plugins: [electron({ clientID: options.desktopClientId ?? desktopAuthClientId })],
  })
  return Object.assign(auth, {
    getSession: async (request: Request) => {
      const session = await auth.api.getSession({ headers: request.headers })
      if (!session?.user) return null
      return Object.freeze({ id: session.user.id, name: session.user.name, email: session.user.email, image: session.user.image ?? null })
    },
  })
}
