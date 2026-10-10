import type { FileAuthorizationAction, SyncAuthorizer, SyncConnectionRequest, SyncPrincipal } from './contracts.js'

export type InternalApiAuthorizerOptions = Readonly<{
  apiBaseUrl: string
  serviceToken: string
  fetch?: typeof globalThis.fetch
}>

const subjectPattern = /^[A-Za-z0-9:._-]{1,128}$/

function forwardedHeaders(request: SyncConnectionRequest, serviceToken: string): Headers {
  const headers = new Headers({ 'Content-Type': 'application/json', 'X-Canvas-Service-Token': serviceToken })
  const authorization = request.headers.authorization
  const cookie = request.headers.cookie
  if (authorization) headers.set('Authorization', authorization)
  else if (cookie) headers.set('Cookie', cookie)
  return headers
}

export function createInternalApiAuthorizer(options: InternalApiAuthorizerOptions): SyncAuthorizer {
  const fetcher = options.fetch ?? globalThis.fetch
  if (typeof fetcher !== 'function') throw new Error('A fetch implementation is required')
  if (new TextEncoder().encode(options.serviceToken).byteLength < 32) throw new Error('API_SERVICE_TOKEN must contain at least 32 bytes')
  const endpointUrl = new URL('/internal/file-access', options.apiBaseUrl)
  if (endpointUrl.protocol !== 'http:' && endpointUrl.protocol !== 'https:') throw new Error('API_BASE_URL must use HTTP or HTTPS')
  const endpoint = endpointUrl.toString()

  const check = async (request: SyncConnectionRequest, fileId: string, access: 'read' | 'write'): Promise<SyncPrincipal | null> => {
    let response: Response
    try {
      response = await fetcher(endpoint, { method: 'POST', headers: forwardedHeaders(request, options.serviceToken), body: JSON.stringify({ fileId, access }), signal: AbortSignal.timeout(5_000) })
    } catch { return null }
    if (!response.ok) { await response.body?.cancel(); return null }
    const declaredLength = Number(response.headers.get('Content-Length'))
    if (Number.isFinite(declaredLength) && declaredLength > 16_384) { await response.body?.cancel(); return null }
    let body: unknown
    try {
      const source = await response.text()
      if (new TextEncoder().encode(source).byteLength > 16_384) return null
      body = JSON.parse(source)
    } catch { return null }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !subjectPattern.test((body as Record<string, unknown>).userId as string)) return null
    return { subjectId: (body as { userId: string }).userId }
  }

  return {
    authorizeConnection: request => request.scopedFileId ? check(request, request.scopedFileId, 'read') : Promise.resolve(null),
    authorizeFile: async ({ principal, request, fileId, action }) => (await check(request, fileId, accessForAction(action)))?.subjectId === principal.subjectId,
  }
}

function accessForAction(action: FileAuthorizationAction): 'read' | 'write' {
  return action === 'write' ? 'write' : 'read'
}
