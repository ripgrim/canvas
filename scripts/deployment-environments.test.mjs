import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const environments = JSON.parse(await readFile(resolve(root, 'deploy/environments.json'), 'utf8'))
const workflow = await readFile(resolve(root, '.github/workflows/promote-staging.yml'), 'utf8')
const stagingTemplate = await readFile(resolve(root, '.env.staging.example'), 'utf8')
const webVercel = JSON.parse(await readFile(resolve(root, 'apps/web/vercel.json'), 'utf8'))
const serviceNames = ['web', 'login', 'api', 'preview', 'thumbnailRenderer', 'assets', 'sync']

test('keeps production on main and staging on its persistent branch', () => {
  assert.equal(environments.production.branch, 'main')
  assert.equal(environments.staging.branch, 'staging')
})

test('uses isolated HTTPS origins for every hosted environment', () => {
  for (const name of serviceNames) {
    const production = new URL(environments.production.origins[name])
    const staging = new URL(environments.staging.origins[name])
    assert.notEqual(staging.origin, production.origin, `${name} must not share its production origin`)
    assert.equal(staging.protocol, name === 'sync' ? 'wss:' : 'https:')
  }
  assert.equal(environments.staging.origins.web, 'https://staging.canvas.ripgrim.com')
  assert.notEqual(environments.staging.origins.preview, environments.staging.origins.web)
})

test('opens one staging-to-main pull request and never pushes main directly', () => {
  assert.match(workflow, /branches:\s*\n\s*- staging/)
  assert.match(workflow, /pull-requests: write/)
  assert.match(workflow, /gh pr list --base main --head staging --state open/)
  assert.match(workflow, /gh pr create[\s\S]*--base main[\s\S]*--head staging/)
  assert.doesNotMatch(workflow, /git push[^\n]*main/)
})

test('keeps browser auth on the staging editor origin with a host-only cookie', () => {
  assert.match(stagingTemplate, /^BETTER_AUTH_URL="https:\/\/staging\.canvas\.ripgrim\.com"$/m)
  assert.match(stagingTemplate, /^AUTH_COOKIE_DOMAIN=""$/m)
  assert.match(stagingTemplate, /^VITE_APP_URL="https:\/\/staging\.canvas\.ripgrim\.com"$/m)
  assert.match(stagingTemplate, /^VITE_API_URL="https:\/\/staging\.canvas\.ripgrim\.com"$/m)
  assert.match(stagingTemplate, /^GITHUB_APP_AUTHORIZATION_CALLBACK_URL="https:\/\/api-staging\.canvas\.ripgrim\.com\/api\/github\/authorization\/callback"$/m)
  assert.doesNotMatch(stagingTemplate, /="https:\/\/(?:api|login|preview|assets|sync)\.canvas\.ripgrim\.com/)

  assert.deepEqual(webVercel.rewrites.slice(0, 2), [
    {
      source: '/api/:path*',
      has: [{ type: 'host', value: 'staging.canvas.ripgrim.com' }],
      destination: 'https://api-staging.canvas.ripgrim.com/api/:path*',
    },
    {
      source: '/api/:path*',
      has: [{ type: 'host', value: 'canvas.ripgrim.com' }],
      destination: 'https://api.canvas.ripgrim.com/api/:path*',
    },
  ])
  assert.deepEqual(webVercel.rewrites.at(-1), { source: '/(.*)', destination: '/_shell.html' })
})
