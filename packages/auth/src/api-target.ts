export function resolveAuthenticatedApiPath(baseURL: string, input: string): string {
  const base = new URL(baseURL)
  const target = new URL(input, base)
  if (target.origin !== base.origin || !target.pathname.startsWith('/api/') || target.hash || target.username || target.password) {
    throw new Error('Authenticated API target is not allowed.')
  }
  return `${target.pathname}${target.search}`
}
