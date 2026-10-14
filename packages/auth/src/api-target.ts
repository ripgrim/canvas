export function resolveAuthenticatedApiPath(baseURL: string, input: string): string {
  const base = new URL(baseURL)
  const target = new URL(input, base)
  if (target.origin !== base.origin || !target.pathname.startsWith('/api/') || target.hash || target.username || target.password) {
    throw new Error('Authenticated API target is not allowed.')
  }
  return target.toString()
}

export type AuthenticatedApiRequestOptions = Readonly<{
  baseURL: string
  path: string
  init?: RequestInit
  cookie: string
  origin: string
  userAgent: string
  fetch: typeof fetch
}>

/** Sends one authenticated main-process API request without exposing its cookie to the renderer. */
export function requestAuthenticatedApi(options: AuthenticatedApiRequestOptions): Promise<Response> {
  const target = resolveAuthenticatedApiPath(options.baseURL, options.path)
  if (!/^[a-z][a-z0-9+.-]{2,63}:\/$/.test(options.origin)) throw new Error('Authenticated API origin is invalid.')
  if (!options.userAgent || /[\r\n]/.test(options.userAgent)) throw new Error('Authenticated API user agent is invalid.')
  const headers = new Headers(options.init?.headers)
  headers.set('Cookie', options.cookie)
  headers.set('Origin', options.origin)
  headers.set('User-Agent', options.userAgent)
  return options.fetch(target, { ...options.init, credentials: 'omit', headers })
}
