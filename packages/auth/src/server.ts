import { electron } from '@better-auth/electron'
import { betterAuth } from 'better-auth'
import type { BetterAuthOptions } from 'better-auth'
import { desktopAuthClientId, desktopAuthProtocolScheme } from './index'

export type HostedAuthOptions = Readonly<{
  database: NonNullable<BetterAuthOptions['database']>
  baseURL: string
  secret: string
  githubClientId: string
  githubClientSecret: string
  desktopScheme: string
  desktopClientId?: string
}>

export type HostedAuth = Readonly<{ handler(request: Request): Promise<Response> }>

type HostedAuthEnvironment = Readonly<Record<string, string | undefined>>

function requiredEnvironment(environment: HostedAuthEnvironment, name: string): string {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`Missing ${name}.`)
  return value
}

export function hostedAuthOptionsFromEnvironment(environment: HostedAuthEnvironment, database: HostedAuthOptions['database']): HostedAuthOptions {
  return {
    database,
    baseURL: requiredEnvironment(environment, 'BETTER_AUTH_URL'),
    secret: requiredEnvironment(environment, 'BETTER_AUTH_SECRET'),
    githubClientId: requiredEnvironment(environment, 'GITHUB_CLIENT_ID'),
    githubClientSecret: requiredEnvironment(environment, 'GITHUB_CLIENT_SECRET'),
    desktopScheme: desktopAuthProtocolScheme,
    desktopClientId: desktopAuthClientId,
  }
}

export function databaseURLFromEnvironment(environment: HostedAuthEnvironment): string {
  const raw = requiredEnvironment(environment, 'DATABASE_URL')
  const url = new URL(raw)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.')
  return url.toString()
}

export function createHostedAuth(options: HostedAuthOptions): HostedAuth {
  const baseURL = new URL(options.baseURL)
  const local = ['127.0.0.1', 'localhost'].includes(baseURL.hostname)
  if (baseURL.username || baseURL.password || baseURL.search || baseURL.hash || (baseURL.protocol !== 'https:' && !(local && baseURL.protocol === 'http:'))) throw new Error('Auth base URL must use HTTPS outside local development.')
  if (options.secret.length < 32) throw new Error('Better Auth secret must contain at least 32 characters.')
  if (!options.githubClientId.trim() || !options.githubClientSecret.trim()) throw new Error('GitHub OAuth credentials are required.')
  if (!/^[a-z][a-z0-9+.-]{2,63}$/.test(options.desktopScheme)) throw new Error('Invalid desktop auth scheme.')
  return betterAuth({
    database: options.database,
    baseURL: baseURL.toString().replace(/\/$/, ''),
    secret: options.secret,
    trustedOrigins: [`${options.desktopScheme}:/`],
    socialProviders: {
      github: {
        clientId: options.githubClientId,
        clientSecret: options.githubClientSecret,
        scope: ['read:user', 'user:email'],
      },
    },
    plugins: [electron({ clientID: options.desktopClientId ?? desktopAuthClientId })],
  })
}
