import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { localEnvironment, localOrigins, localServices, requiredLocalEnvironment, sharedBuildPackages } from './local-services.mjs'

const desktopPackage = JSON.parse(readFileSync(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'))

assert.equal(localServices.length, 10)
assert.equal(new Set(localServices.map(service => service.id)).size, localServices.length)
assert.equal(new Set(localServices.map(service => service.port)).size, localServices.length)
assert.deepEqual(localServices.map(service => service.port), [4317, 4318, 4319, 4320, 4321, 4322, 4323, 4324, 4325, 4326])
assert.equal(localEnvironment.VITE_SYNC_ORIGIN, 'ws://127.0.0.1:4321')
assert.equal(localEnvironment.SYNC_ROOM_RUNTIME_ORIGIN, localOrigins.syncRoom)
assert.equal(localEnvironment.COLLABORATION_BUILD_ID, '0.1.0')
assert.equal(localEnvironment.API_BASE_URL, localOrigins.api)
assert.ok(localServices.find(service => service.id === 'api')?.environment.includes('DATABASE_URL'))
assert.ok(localServices.find(service => service.id === 'api')?.environment.includes('COLLABORATION_ADMISSION_SERVICE_TOKEN'))
assert.ok(localServices.find(service => service.id === 'api')?.environment.includes('COLLABORATION_BUILD_ID'))
assert.ok(localServices.find(service => service.id === 'api')?.environment.includes('ASSETS_ORIGIN'))
assert.ok(localServices.find(service => service.id === 'thumbnail-jobs')?.environment.includes('THUMBNAIL_SERVICE_TOKEN'))
assert.ok(localServices.find(service => service.id === 'preview')?.environment.includes('CANVAS_VERIFIED_COMPONENT_REGISTRY'))
assert.ok(localServices.find(service => service.id === 'thumbnail-renderer')?.environment.includes('CANVAS_VERIFIED_COMPONENT_REGISTRY'))
assert.ok(localServices.find(service => service.id === 'assets')?.trailingArgs.includes('--show-interactive-dev-session=false'))
assert.equal(localServices.find(service => service.id === 'sync')?.packageName, '@canvas/sync-worker')
assert.ok(localServices.find(service => service.id === 'sync')?.trailingArgs.includes('--show-interactive-dev-session=false'))
assert.ok(localServices.find(service => service.id === 'sync')?.environment.includes('SYNC_COORDINATOR_INTERNAL_SECRET'))
assert.ok(!localServices.find(service => service.id === 'sync')?.environment.includes('SYNC_ROOM_TICKET_SECRET'))
assert.equal(localServices.find(service => service.id === 'sync-room')?.packageName, '@canvas/sync-room-core')
assert.ok(localServices.find(service => service.id === 'sync-room')?.environment.includes('SYNC_ROOM_TICKET_SECRET'))
assert.equal(localServices.find(service => service.id === 'sync-coordinator')?.packageName, '@canvas/sync-coordinator')
assert.ok(localServices.find(service => service.id === 'sync-coordinator')?.environment.includes('SYNC_ROOM_TICKET_SECRET'))
assert.ok(!localServices.find(service => service.id === 'sync-coordinator')?.environment.includes('COLLABORATION_ADMISSION_SERVICE_TOKEN'))
assert.deepEqual(localServices.find(service => service.id === 'assets')?.readyStatuses, [404])
assert.ok(requiredLocalEnvironment.includes('BETTER_AUTH_SECRET'))
assert.ok(sharedBuildPackages.includes('@canvas/files'))
assert.ok(sharedBuildPackages.includes('@canvas/scanner'))
assert.ok(sharedBuildPackages.includes('@canvas/preview-runtime'))
assert.ok(sharedBuildPackages.includes('@canvas/sync-service'))
assert.ok(sharedBuildPackages.includes('@canvas/sync-room-core'))
assert.match(desktopPackage.scripts.dev, /electron \. --development$/)
for (const service of localServices) {
  assert.match(service.packageName, /^@canvas\//)
  assert.equal(new URL(service.readyUrl).hostname, '127.0.0.1')
  assert.equal(Number(new URL(service.readyUrl).port), service.port)
  assert.ok(service.readyStatuses.every(status => Number.isSafeInteger(status) && status >= 100 && status <= 599))
}

process.stdout.write(`SERVICE_TOPOLOGY_EVIDENCE ${JSON.stringify({ services: localServices.map(({ id, port, readyUrl }) => ({ id, port, readyUrl })) })}\n`)

