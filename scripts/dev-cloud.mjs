import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnvironment } from 'dotenv'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
loadEnvironment({ path: resolve(root, '.env'), quiet: true })
loadEnvironment({ path: resolve(root, '.env.local'), quiet: true, override: true })
const pnpm = process.env.npm_execpath
if (!pnpm) throw new Error('Run this command through pnpm dev:cloud.')

Object.assign(process.env, {
  BETTER_AUTH_URL: 'http://127.0.0.1:4320',
  LOGIN_URL: 'http://127.0.0.1:4319',
  APP_URL: 'http://127.0.0.1:4317',
  VITE_API_URL: 'http://127.0.0.1:4320',
  VITE_APP_URL: 'http://127.0.0.1:4317',
  VITE_API_ORIGIN: 'http://127.0.0.1:4320',
  VITE_LOGIN_ORIGIN: 'http://127.0.0.1:4319',
  VITE_PREVIEW_ORIGIN: 'http://127.0.0.1:4318',
  VITE_ASSETS_ORIGIN: 'http://127.0.0.1:4322',
  VITE_SYNC_ORIGIN: 'ws://127.0.0.1:4321',
  DESIGN_EDITOR_AUTH_URL: 'http://127.0.0.1:4320',
  DESIGN_EDITOR_LOGIN_URL: 'http://127.0.0.1:4319',
  DESIGN_EDITOR_PREVIEW_URL: 'http://127.0.0.1:4318',
  DESIGN_EDITOR_ASSETS_URL: 'http://127.0.0.1:4322',
  API_ORIGIN: 'http://127.0.0.1:4320',
  ALLOWED_ORIGINS: 'http://127.0.0.1:4317,http://127.0.0.1:4319',
})

const required = name => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required. Add it to .env.local.`)
  if (value.includes('\n') || value.includes('\r')) throw new Error(`${name} cannot contain a line break.`)
  return value
}

const workerVars = resolve(root, 'apps/workers/.dev.vars')
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

function launch(label, args, environment, stopWhenComplete = false) {
  const child = spawn(process.execPath, [pnpm, ...args], { cwd: root, env: environment, windowsHide: true, stdio: 'inherit' })
  children.add(child)
  child.once('exit', code => {
    children.delete(child)
    if (!stopping && (stopWhenComplete || code !== 0)) void stop(code ?? 0, `${label} stopped.`)
  })
  child.once('error', error => { process.stderr.write(`${label}: ${error.message}\n`); void stop(1) })
}

async function stop(code, message) {
  if (stopping) return
  stopping = true
  if (message) process.stderr.write(`${message}\n`)
  for (const child of children) child.kill()
  await rm(workerVars, { force: true })
  process.exitCode = code
  finishLifetime()
}

async function ready(url, label) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (stopping) throw new Error(`${label} stopped before it became ready.`)
    try { await fetch(url); return } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }
  throw new Error(`${label} did not become ready.`)
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop(0) })
process.on('exit', () => { if (existsSync(workerVars)) rmSync(workerVars, { force: true }) })

const serviceToken = process.env.API_SERVICE_TOKEN?.trim() || randomBytes(48).toString('base64url')
const uploadSecret = process.env.UPLOAD_INTENT_SECRET?.trim() || randomBytes(48).toString('base64url')
process.env.API_SERVICE_TOKEN = serviceToken
process.env.UPLOAD_INTENT_SECRET = uploadSecret
required('DATABASE_URL')
required('BETTER_AUTH_SECRET')
required('GITHUB_CLIENT_ID')
required('GITHUB_CLIENT_SECRET')

process.stdout.write('Starting Docker Postgres and applying auth and control-plane migrations.\n')
run(['db:setup'], environmentFor('DATABASE_URL', 'BETTER_AUTH_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'BETTER_AUTH_URL', 'LOGIN_URL', 'APP_URL', 'AUTH_TRUSTED_ORIGINS', 'AUTH_COOKIE_DOMAIN'))
process.stdout.write('Building shared cloud packages.\n')
for (const name of ['@canvas/auth', '@canvas/database', '@canvas/cloud-document', '@canvas/cloud-client', '@canvas/files', '@canvas/sync-protocol']) run(['--filter', name, 'build'])
await writeFile(workerVars, `API_SERVICE_TOKEN=${serviceToken}\nUPLOAD_INTENT_SECRET=${uploadSecret}\n`, { encoding: 'utf8', mode: 0o600 })

launch('API', ['--filter', '@canvas/api', 'dev'], { ...environmentFor('DATABASE_URL', 'BETTER_AUTH_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'BETTER_AUTH_URL', 'LOGIN_URL', 'APP_URL', 'AUTH_TRUSTED_ORIGINS', 'AUTH_COOKIE_DOMAIN', 'API_SERVICE_TOKEN'), PORT: '4320' })
launch('Login', ['--filter', '@canvas/login', 'dev'], publicEnvironment)
launch('Sync', ['--filter', '@canvas/sync-service', 'dev'], { ...environmentFor('DATABASE_URL', 'API_SERVICE_TOKEN', 'API_BASE_URL', 'ALLOWED_ORIGINS', 'SYNC_MAX_MESSAGE_BYTES', 'SYNC_HISTORY_LIMIT'), PORT: '4321', HOST: '127.0.0.1' })
launch('Assets', ['--filter', '@canvas/workers', 'dev', '--', '--show-interactive-dev-session=false'], publicEnvironment)
launch('Web', ['--filter', '@canvas/web', 'dev'], publicEnvironment)
launch('Preview', ['--filter', '@canvas/web', 'dev:preview'], publicEnvironment)

try {
  await Promise.all([
    ready('http://127.0.0.1:4317/', 'Web'),
    ready('http://127.0.0.1:4318/', 'Preview'),
    ready('http://127.0.0.1:4319/', 'Login'),
    ready('http://127.0.0.1:4320/healthz', 'API'),
    ready('http://127.0.0.1:4321/', 'Sync'),
    ready('http://127.0.0.1:4322/', 'Assets'),
  ])
  process.stdout.write('Web: http://127.0.0.1:4317/\nLogin: http://127.0.0.1:4319/\nAPI: http://127.0.0.1:4320/\nSync: ws://127.0.0.1:4321/sync/:fileId?tabId=:clientId\nAssets: http://127.0.0.1:4322/\n')
  if (process.argv.includes('--desktop')) {
    process.stdout.write('Opening the thin Electron host.\n')
    launch('Desktop', ['--filter', '@canvas/desktop', 'dev'], publicEnvironment, true)
  }
} catch (error) {
  await stop(1, error instanceof Error ? error.message : String(error))
}

await lifetime
