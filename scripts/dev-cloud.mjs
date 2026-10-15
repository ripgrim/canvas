import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { config as loadEnvironment } from 'dotenv'
import { processErrorDecision, processExitDecision } from './dev-process-lifecycle.mjs'
import { githubAppAuthorizationCallbackURL, localEnvironment, localOrigins, localServices, requiredLocalEnvironment, sharedBuildPackages } from './local-services.mjs'
import { localRegistryEnvironment, prepareLocalRegistry } from './local-registry.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
loadEnvironment({ path: resolve(root, '.env'), quiet: true })
loadEnvironment({ path: resolve(root, '.env.local'), quiet: true, override: true })
const pnpm = process.env.npm_execpath
if (!pnpm) throw new Error('Run this command through pnpm dev:cloud.')

Object.assign(process.env, localEnvironment)
const githubAppCallbackURL = githubAppAuthorizationCallbackURL(process.env)
if (githubAppCallbackURL) process.env.GITHUB_APP_AUTHORIZATION_CALLBACK_URL = githubAppCallbackURL

const required = name => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required. Add it to .env.local.`)
  if (value.includes('\n') || value.includes('\r')) throw new Error(`${name} cannot contain a line break.`)
  return value
}

const assetWorkerVars = resolve(root, 'apps/workers/.dev.vars')
const syncWorkerVars = resolve(root, 'apps/sync-worker/.dev.vars')
const syncCoordinatorVars = resolve(root, 'apps/sync-coordinator/.dev.vars')
const localVarFiles = Object.freeze([assetWorkerVars, syncWorkerVars, syncCoordinatorVars])
const localTemporaryDirectories = []
const children = new Set()
let stopping = false
let finishLifetime = () => undefined
const lifetime = new Promise(resolveLifetime => { finishLifetime = resolveLifetime })
const secretName = /(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|DATABASE_URL|PGPASSWORD)/i
const serverOnlyNames = new Set(['AUTH_COOKIE_DOMAIN', 'AUTH_TRUSTED_ORIGINS', 'GITHUB_CLIENT_ID', 'HOST', 'PORT'])
const publicEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !secretName.test(name) && !serverOnlyNames.has(name)))
const environmentFor = (...names) => {
  const environment = { ...publicEnvironment }
  for (const name of names) if (process.env[name] !== undefined) environment[name] = process.env[name]
  return environment
}

function run(args, environment = publicEnvironment) {
  const result = spawnSync(process.execPath, [pnpm, ...args], { cwd: root, env: environment, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed.`)
}

function launch(label, args, environment, kind = 'required-service') {
  const child = spawn(process.execPath, [pnpm, ...args], { cwd: root, env: environment, windowsHide: true, stdio: 'inherit' })
  children.add(child)
  child.once('exit', code => {
    children.delete(child)
    if (stopping) return
    const decision = processExitDecision(kind, code)
    if (decision.stopStack) void stop(decision.exitCode, `${label} stopped.`)
    else process.stderr.write(`${label} stopped. Cloud services remain available.\n`)
  })
  child.once('error', error => {
    const decision = processErrorDecision(kind)
    process.stderr.write(`${label}: ${error.message}\n`)
    if (!stopping && decision.stopStack) void stop(decision.exitCode)
  })
}

async function stop(code, message) {
  if (stopping) return
  stopping = true
  if (message) process.stderr.write(`${message}\n`)
  await Promise.all([...children].map(stopChild))
  await Promise.all(localVarFiles.map(path => rm(path, { force: true })))
  await Promise.all(localTemporaryDirectories.map(path => rm(path, { force: true, recursive: true })))
  process.exitCode = code
  finishLifetime()
}

async function ready(url, label, statuses) {
  let lastError
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (stopping) throw new Error(`${label} stopped before it became ready.`)
    try {
      const response = await fetch(url, { redirect: 'manual' })
      if (statuses.includes(response.status)) return
    } catch (error) { lastError = error }
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }
  throw new Error(`${label} did not become ready.`, { cause: lastError })
}

async function registryFingerprint(origin, label, fingerprint) {
  const response = await fetch(`${origin}/@id/__x00__virtual:canvas-verified-component-registry`)
  if (!response.ok) throw new Error(`${label} did not expose its verified registry contract.`)
  const source = await response.text()
  if (!source.includes(JSON.stringify(fingerprint))) throw new Error(`${label} did not consume the prepared verified registry.`)
  return fingerprint
}

function stopChild(child) {
  if (!child.pid || child.exitCode !== null) return Promise.resolve()
  if (process.platform !== 'win32') {
    child.kill('SIGTERM')
    return Promise.resolve()
  }
  return new Promise(resolveStop => {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    killer.once('error', () => { child.kill(); resolveStop() })
    killer.once('exit', () => resolveStop())
  })
}

function portAvailable(port) {
  return new Promise(resolveAvailability => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolveAvailability(false))
    server.listen({ host: '127.0.0.1', port }, () => server.close(() => resolveAvailability(true)))
  })
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop(0) })
process.on('exit', () => {
  for (const path of localVarFiles) if (existsSync(path)) rmSync(path, { force: true })
  const safePrefix = `${resolve(tmpdir())}${sep}canvas-sync-room-`
  for (const path of localTemporaryDirectories) if (resolve(path).startsWith(safePrefix) && existsSync(path)) rmSync(path, { force: true, recursive: true })
})

const serviceToken = process.env.API_SERVICE_TOKEN?.trim() || randomBytes(48).toString('base64url')
const collaborationAdmissionServiceToken = process.env.COLLABORATION_ADMISSION_SERVICE_TOKEN?.trim() || randomBytes(48).toString('base64url')
const uploadSecret = process.env.UPLOAD_INTENT_SECRET?.trim() || randomBytes(48).toString('base64url')
const thumbnailServiceToken = process.env.THUMBNAIL_SERVICE_TOKEN?.trim() || randomBytes(48).toString('base64url')
const thumbnailJobTriggerToken = process.env.THUMBNAIL_JOB_TRIGGER_TOKEN?.trim() || randomBytes(48).toString('base64url')
const syncCoordinatorInternalSecret = process.env.SYNC_COORDINATOR_INTERNAL_SECRET?.trim() || randomBytes(48).toString('base64url')
const syncRoomTicketSecret = process.env.SYNC_ROOM_TICKET_SECRET?.trim() || randomBytes(48).toString('base64url')
process.env.API_SERVICE_TOKEN = serviceToken
process.env.COLLABORATION_ADMISSION_SERVICE_TOKEN = collaborationAdmissionServiceToken
process.env.UPLOAD_INTENT_SECRET = uploadSecret
process.env.THUMBNAIL_SERVICE_TOKEN = thumbnailServiceToken
process.env.THUMBNAIL_JOB_TRIGGER_TOKEN = thumbnailJobTriggerToken
process.env.SYNC_COORDINATOR_INTERNAL_SECRET = syncCoordinatorInternalSecret
process.env.SYNC_ROOM_TICKET_SECRET = syncRoomTicketSecret
const syncRoomCheckpointDirectory = await mkdtemp(resolve(tmpdir(), 'canvas-sync-room-'))
localTemporaryDirectories.push(syncRoomCheckpointDirectory)
process.env.SYNC_ROOM_CHECKPOINT_DIR = syncRoomCheckpointDirectory
for (const name of requiredLocalEnvironment) required(name)
const occupiedServices = []
for (const service of localServices) if (!await portAvailable(service.port)) occupiedServices.push(`${service.label} (${service.port})`)
if (occupiedServices.length) throw new Error(`Local service ports are already in use: ${occupiedServices.join(', ')}. Stop the existing stack before starting another one.`)

process.stdout.write('Starting Docker Postgres and applying auth and control-plane migrations.\n')
run(['db:setup'], environmentFor('DATABASE_URL', 'BETTER_AUTH_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'BETTER_AUTH_URL', 'LOGIN_URL', 'APP_URL', 'AUTH_TRUSTED_ORIGINS', 'AUTH_COOKIE_DOMAIN'))
process.stdout.write('Building shared cloud packages.\n')
for (const name of sharedBuildPackages) run(['--filter', name, 'build'])
const localRegistry = await prepareLocalRegistry({ root })
Object.assign(process.env, localRegistryEnvironment(localRegistry))
process.stdout.write(`LOCAL_REGISTRY_EVIDENCE ${JSON.stringify(localRegistry)}\n`)
await writeFile(assetWorkerVars, [
  `API_SERVICE_TOKEN=${serviceToken}`,
  `UPLOAD_INTENT_SECRET=${uploadSecret}`,
  `THUMBNAIL_SERVICE_TOKEN=${thumbnailServiceToken}`,
  `API_ORIGIN=${localEnvironment.API_ORIGIN}`,
  `ALLOWED_ORIGINS=${localEnvironment.ALLOWED_ORIGINS}`,
  '',
].join('\n'), { encoding: 'utf8', mode: 0o600 })
await writeFile(syncWorkerVars, [
  `COLLABORATION_ADMISSION_SERVICE_TOKEN=${collaborationAdmissionServiceToken}`,
  `SYNC_COORDINATOR_INTERNAL_SECRET=${syncCoordinatorInternalSecret}`,
  `COLLABORATION_BUILD_ID=${localEnvironment.COLLABORATION_BUILD_ID}`,
  `API_ORIGIN=${localEnvironment.API_ORIGIN}`,
  `ALLOWED_ORIGINS=${localEnvironment.ALLOWED_ORIGINS}`,
  '',
].join('\n'), { encoding: 'utf8', mode: 0o600 })
await writeFile(syncCoordinatorVars, [
  `DATABASE_URL=${required('DATABASE_URL')}`,
  `SYNC_COORDINATOR_INTERNAL_SECRET=${syncCoordinatorInternalSecret}`,
  `SYNC_ROOM_TICKET_SECRET=${syncRoomTicketSecret}`,
  `SYNC_ROOM_RUNTIME_ORIGIN=${localEnvironment.SYNC_ROOM_RUNTIME_ORIGIN}`,
  `ALLOWED_ORIGINS=${localEnvironment.ALLOWED_ORIGINS}`,
  '',
].join('\n'), { encoding: 'utf8', mode: 0o600 })

for (const service of localServices) {
  const args = ['--filter', service.packageName, service.script]
  const trailingArgs = [...service.trailingArgs]
  if (process.platform === 'win32' && service.id === 'sync-coordinator') trailingArgs.push('--enable-containers=false')
  if (trailingArgs.length) args.push(...trailingArgs)
  launch(service.label, args, { ...environmentFor(...service.environment), ...service.fixedEnvironment, PORT: String(service.port) })
}

try {
  await Promise.all(localServices.map(service => ready(service.readyUrl, service.label, service.readyStatuses)))
  const registryConsumers = await Promise.all([
    registryFingerprint(localOrigins.preview, 'Preview', localRegistry.fingerprint),
    registryFingerprint(localOrigins.thumbnailRenderer, 'Thumbnail renderer', localRegistry.fingerprint),
  ])
  if (new Set(registryConsumers).size !== 1 || registryConsumers[0] === 'sha256-empty') throw new Error('Local registry consumers did not share one nonempty fingerprint.')
  for (const service of localServices) process.stdout.write(`${service.label}: ${service.readyUrl}\n`)
  if (process.argv.includes('--check')) {
    process.stdout.write(`LOCAL_STACK_EVIDENCE ${JSON.stringify({ registry: localRegistry, registryConsumers: { preview: registryConsumers[0], thumbnailRenderer: registryConsumers[1] }, services: localServices.map(({ id, readyUrl }) => ({ id, readyUrl })) })}\n`)
    await stop(0)
  }
  if (process.argv.includes('--desktop')) {
    process.stdout.write('Opening the thin Electron host.\n')
    launch('Desktop', ['--filter', '@canvas/desktop', 'dev'], publicEnvironment, 'desktop-shell')
  }
} catch (error) {
  await stop(1, error instanceof Error ? error.message : String(error))
}

await lifetime
