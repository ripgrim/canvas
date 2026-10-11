import { handleApiRequest, restoreVercelRequestPath } from '../src/runtime.js'

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handleApiRequest(restoreVercelRequestPath(request))
    } catch (error) {
      const requestId = crypto.randomUUID()
      const failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { name: 'UnknownError', message: String(error) }
      console.error(JSON.stringify({ level: 'error', event: 'api_runtime_failed', requestId, method: request.method, pathname: new URL(request.url).pathname, error: failure }))
      const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Canvas-Request-Id': requestId })
      const origin = request.headers.get('Origin')
      const allowed = [process.env.LOGIN_URL, process.env.APP_URL].flatMap(value => value?.split(',') ?? []).map(value => value.trim()).filter(Boolean)
      if (origin && allowed.some(value => { try { return new URL(value).origin === origin } catch { return false } })) {
        headers.set('Access-Control-Allow-Origin', origin)
        headers.set('Access-Control-Allow-Credentials', 'true')
        headers.set('Access-Control-Expose-Headers', 'X-Canvas-Request-Id')
        headers.append('Vary', 'Origin')
      }
      return new Response(JSON.stringify({ error: { code: 'internal_error', message: 'Request could not be completed.', requestId } }), { status: 500, headers })
    }
  },
}

