import assert from 'node:assert/strict'

const origins = Object.freeze({
  api: 'https://api.canvas.ripgrim.com',
  assets: 'https://assets.canvas.ripgrim.com',
  login: 'https://login.canvas.ripgrim.com',
  preview: 'https://preview.canvas.ripgrim.com',
  thumbnailRenderer: 'https://thumbnails.canvas.ripgrim.com',
  web: 'https://canvas.ripgrim.com',
})

for (const [service, url] of Object.entries({ web: origins.web, login: origins.login, preview: `${origins.preview}/?editorOrigin=${encodeURIComponent(origins.web)}`, thumbnailRenderer: `${origins.thumbnailRenderer}/thumbnail-renderer` })) {
  const response = await fetch(url)
  assert.equal(response.status, 200, `${service} returned ${response.status}`)
}

const health = await fetch(`${origins.api}/healthz`)
assert.equal(health.status, 200)
assert.deepEqual(await health.json(), { ok: true })

const authPreflight = await fetch(`${origins.api}/api/auth/sign-in/social`, {
  method: 'OPTIONS',
  headers: {
    Origin: origins.login,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type',
  },
})
assert.equal(authPreflight.status, 204)
assert.equal(authPreflight.headers.get('access-control-allow-origin'), origins.login)
assert.equal(authPreflight.headers.get('access-control-allow-credentials'), 'true')

const assetPreflight = await fetch(`${origins.assets}/uploads/intents`, {
  method: 'OPTIONS',
  headers: {
    Origin: origins.web,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type',
  },
})
assert.equal(assetPreflight.status, 204)
assert.equal(assetPreflight.headers.get('access-control-allow-origin'), origins.web)

const preview = await fetch(`${origins.preview}/?editorOrigin=${encodeURIComponent(origins.web)}`)
assert.match(preview.headers.get('content-security-policy') ?? '', new RegExp(`frame-ancestors [^;]*${origins.web.replaceAll('.', '\\.').replaceAll('/', '\\/')}`))

process.stdout.write(`PRODUCTION_SURFACE_EVIDENCE ${JSON.stringify({ origins, api: health.status, authCors: authPreflight.status, assetsCors: assetPreflight.status })}\n`)
