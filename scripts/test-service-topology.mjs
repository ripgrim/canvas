import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { browserOrigins, localEnvironment, localOrigins, localServices, remoteDevPorts, requiredLocalEnvironment, sharedBuildPackages } from './local-services.mjs'

const desktopPackage = JSON.parse(readFileSync(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'))
const syncRoomPackage = JSON.parse(readFileSync(new URL('../apps/sync-room-core/package.json', import.meta.url), 'utf8'))
const syncRoomTsconfig = JSON.parse(readFileSync(new URL('../apps/sync-room-core/tsconfig.json', import.meta.url), 'utf8'))
const workspacePackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const devCloudSource = readFileSync(new URL('./dev-cloud.mjs', import.meta.url), 'utf8')
const repositoryJobsSource = readFileSync(new URL('../apps/repository-jobs/src/serve.ts', import.meta.url), 'utf8')
const builderDockerfile = readFileSync(new URL('../infra/hosted-preview-builder/Dockerfile', import.meta.url), 'utf8')

assert.equal(localServices.length, 11)
assert.equal(new Set(localServices.map(service => service.id)).size, localServices.length)
assert.equal(new Set(localServices.map(service => service.port)).size, localServices.length)
assert.deepEqual(localServices.map(service => service.port), [4317, 4318, 4319, 4320, 4321, 4322, 4323, 4324, 4325, 4326, 4327])
assert.equal(localEnvironment.VITE_SYNC_ORIGIN, 'ws://127.0.0.1:4321')
assert.equal(browserOrigins.web, localOrigins.web)
assert.deepEqual(Object.values(remoteDevPorts), [9443, 9444, 9445, 9446, 9447, 9448])
assert.equal(localEnvironment.SYNC_ROOM_RUNTIME_ORIGIN, localOrigins.syncRoom)
assert.equal(localEnvironment.COLLABORATION_BUILD_ID, workspacePackage.version)
assert.equal(localEnvironment.API_BASE_URL, localOrigins.api)
assert.ok(localServices.find(service => service.id === 'api')?.environment.includes('DATABASE_URL'))
assert.ok(localServices.find(service => service.id === 'api')?.environment.includes('REPOSITORY_JOB_SERVICE_TOKEN'))
assert.ok(localServices.find(service => service.id === 'api')?.environment.includes('HOSTED_PREVIEW_BUILD_SERVICE_TOKEN'))
assert.ok(localServices.find(service => service.id === 'api')?.environment.includes('HOSTED_PREVIEW_WRITE_SECRET'))
assert.ok(localServices.find(service => service.id === 'assets')?.environment.includes('HOSTED_PREVIEW_WRITE_SECRET'))
assert.ok(localServices.find(service => service.id === 'repository-jobs')?.environment.includes('HOSTED_PREVIEW_BUILD_SERVICE_TOKEN'))
assert.ok(localServices.find(service => service.id === 'repository-jobs')?.environment.includes('HOSTED_PREVIEW_PUBLISHER_SERVICE_TOKEN'))
assert.ok(localServices.find(service => service.id === 'repository-jobs')?.environment.includes('HOSTED_PREVIEW_BUILDER_IMAGE'))
assert.match(devCloudSource, /process\.env\.HOSTED_PREVIEW_BUILDER_IMAGE = localHostedPreviewBuilderImage\(\)/)
assert.match(repositoryJobsSource, /required\('HOSTED_PREVIEW_BUILDER_IMAGE'\)/)
assert.match(builderDockerfile, /^FROM [^\r\n]+@sha256:[a-f0-9]{64}$/m)
assert.ok(localServices.find(service => service.id === 'api')?.environment.includes('COLLABORATION_ADMISSION_SERVICE_TOKEN'))
assert.ok(localServices.find(service => service.id === 'api')?.environment.includes('COLLABORATION_BUILD_ID'))
assert.ok(localServices.find(service => service.id === 'api')?.environment.includes('ASSETS_ORIGIN'))
assert.ok(localServices.find(service => service.id === 'api')?.environment.includes('HOSTED_PREVIEW_PUBLISHER_SERVICE_TOKEN'))
assert.ok(localServices.find(service => service.id === 'api')?.environment.includes('HOSTED_PREVIEW_CAPABILITY_SECRET'))
assert.ok(localServices.find(service => service.id === 'api')?.environment.includes('HOSTED_PREVIEW_ORIGIN'))
assert.ok(localServices.find(service => service.id === 'thumbnail-jobs')?.environment.includes('THUMBNAIL_SERVICE_TOKEN'))
assert.ok(localServices.find(service => service.id === 'repository-jobs')?.environment.includes('REPOSITORY_JOB_SERVICE_TOKEN'))
assert.ok(localServices.find(service => service.id === 'preview')?.environment.includes('CANVAS_VERIFIED_COMPONENT_REGISTRY'))
assert.ok(localServices.find(service => service.id === 'thumbnail-renderer')?.environment.includes('CANVAS_VERIFIED_COMPONENT_REGISTRY'))
assert.ok(localServices.find(service => service.id === 'assets')?.trailingArgs.includes('--show-interactive-dev-session=false'))
assert.equal(localServices.find(service => service.id === 'sync')?.packageName, '@canvas/sync-worker')
assert.ok(localServices.find(service => service.id === 'sync')?.trailingArgs.includes('--show-interactive-dev-session=false'))
assert.ok(localServices.find(service => service.id === 'sync')?.environment.includes('SYNC_COORDINATOR_INTERNAL_SECRET'))
assert.ok(!localServices.find(service => service.id === 'sync')?.environment.includes('SYNC_ROOM_TICKET_SECRET'))
assert.equal(localServices.find(service => service.id === 'sync-room')?.packageName, '@canvas/sync-room-core')
assert.ok(localServices.find(service => service.id === 'sync-room')?.environment.includes('SYNC_ROOM_TICKET_SECRET'))
assert.equal(syncRoomPackage.scripts.dev, 'tsx watch --clear-screen=false src/dev-host.ts')
assert.equal(syncRoomTsconfig.compilerOptions.paths['@canvas/repo-engine/file-document'][0], '../../packages/repo-engine/src/file-document.ts')
assert.equal(syncRoomTsconfig.compilerOptions.paths['@canvas/repo-engine/hosted-catalog'][0], '../../packages/repo-engine/src/hosted-catalog.ts')
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

const remote = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', "const m=await import('./scripts/local-services.mjs'); console.log(JSON.stringify({ origins:m.browserOrigins, environment:m.localEnvironment, githubAppCallback:m.githubAppAuthorizationCallbackURL({GITHUB_APP_ID:'1'}), missingGitHubAppCallback:m.githubAppAuthorizationCallbackURL({}) ?? null }))"], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
  env: { ...process.env, CANVAS_REMOTE_DEV_HOST: 'desktop.example.ts.net' },
}))
assert.equal(remote.origins.web, 'https://desktop.example.ts.net:9443')
assert.equal(remote.origins.preview, 'https://desktop.example.ts.net:9444')
assert.equal(remote.origins.login, 'https://desktop.example.ts.net:9445')
assert.equal(remote.origins.api, 'https://desktop.example.ts.net:9446')
assert.equal(remote.origins.sync, 'https://desktop.example.ts.net:9447')
assert.equal(remote.origins.assets, 'https://desktop.example.ts.net:9448')
assert.equal(remote.environment.VITE_SYNC_ORIGIN, 'wss://desktop.example.ts.net:9447')
assert.equal(remote.environment.API_BASE_URL, localOrigins.api)
assert.equal(remote.environment.API_ORIGIN, localOrigins.api)
assert.equal(remote.environment.ASSETS_ORIGIN, localOrigins.assets)
assert.equal(remote.environment.HOSTED_PREVIEW_ORIGIN, 'https://desktop.example.ts.net:9444')
assert.equal(remote.githubAppCallback, 'https://desktop.example.ts.net:9446/api/github/authorization/callback')
assert.equal(remote.missingGitHubAppCallback, null)
assert.equal(remote.environment.AUTH_TRUSTED_ORIGINS, 'https://desktop.example.ts.net:9443,https://desktop.example.ts.net:9445')
assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', "await import('./scripts/local-services.mjs')"], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, CANVAS_REMOTE_DEV_HOST: 'example.com' },
  stdio: 'pipe',
}))

process.stdout.write(`SERVICE_TOPOLOGY_EVIDENCE ${JSON.stringify({ services: localServices.map(({ id, port, readyUrl }) => ({ id, port, readyUrl })) })}\n`)

