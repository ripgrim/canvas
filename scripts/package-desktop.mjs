import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'dotenv'

const publicNames = [
  'VITE_API_URL',
  'VITE_APP_URL',
  'VITE_API_ORIGIN',
  'VITE_LOGIN_ORIGIN',
  'VITE_PREVIEW_ORIGIN',
  'VITE_ASSETS_ORIGIN',
  'VITE_SYNC_ORIGIN',
  'VITE_COLLABORATION_BUILD_ID',
  'DESIGN_EDITOR_AUTH_URL',
  'DESIGN_EDITOR_LOGIN_URL',
  'DESIGN_EDITOR_PREVIEW_URL',
  'DESIGN_EDITOR_ASSETS_URL',
  'DESIGN_EDITOR_UPDATE_URL',
  'VITE_DATABUDDY_CLIENT_ID',
]
const localDefaults = {
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
  DESIGN_EDITOR_UPDATE_URL: '',
}
const requiredProductionNames = [
  'VITE_APP_URL',
  'VITE_SYNC_ORIGIN',
  'VITE_COLLABORATION_BUILD_ID',
  'DESIGN_EDITOR_AUTH_URL',
  'DESIGN_EDITOR_LOGIN_URL',
  'DESIGN_EDITOR_PREVIEW_URL',
  'DESIGN_EDITOR_ASSETS_URL',
  'DESIGN_EDITOR_UPDATE_URL',
]
const operatingSystemAndToolchainNames = new Set([
  'APPDATA',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'NPM_EXECPATH',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
])

export function createPackageEnvironment(baseEnvironment, configured, requestedMode) {
  if (!['local', 'staging', 'production'].includes(requestedMode)) throw new Error('Package mode must be local, staging, or production.')

  const selected = requestedMode === 'local' ? { ...localDefaults, ...configured } : configured
  if (requestedMode !== 'local') {
    const missing = requiredProductionNames.filter(name => !selected[name]?.trim())
    if (missing.length) throw new Error(`Missing ${requestedMode} desktop configuration: ${missing.join(', ')}.`)
  }

  const environment = Object.fromEntries(Object.entries(baseEnvironment).filter(([name]) => operatingSystemAndToolchainNames.has(name.toUpperCase())))
  for (const name of publicNames) environment[name] = selected[name]?.trim() ?? ''
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'DESIGN_EDITOR_RELEASE_VERSION', 'DESIGN_EDITOR_WINDOWS_PUBLISHER', 'DESIGN_EDITOR_UPDATABLE']) if (baseEnvironment[name]) environment[name] = baseEnvironment[name]
  environment.DESIGN_EDITOR_PACKAGE_MODE = requestedMode
  environment.NODE_ENV = 'production'
  return environment
}

export function createBuilderArguments(requestedMode, environment) {
  const builder = ['--filter', '@canvas/desktop', 'exec', 'electron-builder', '--win', 'nsis', '--publish', 'never', `--config.directories.output=release/${requestedMode}`]
  if (requestedMode !== 'local' && environment.DESIGN_EDITOR_UPDATABLE === '1') {
    const releaseVersion = environment.DESIGN_EDITOR_RELEASE_VERSION
    if (!releaseVersion) throw new Error(`Missing ${requestedMode} release version.`)
    builder.push(`--config.extraMetadata.version=${releaseVersion}`, '--config.publish.provider=generic', `--config.publish.url=${environment.DESIGN_EDITOR_UPDATE_URL}`, `--config.publish.channel=${requestedMode === 'staging' ? 'nightly' : 'latest'}`)
    if (requestedMode === 'staging') builder.push('--config.appId=com.comp-canvas.desktop.nightly', '--config.productName=Comp Canvas Nightly')
    if (environment.DESIGN_EDITOR_WINDOWS_PUBLISHER) builder.push(`--config.win.publisherName=${environment.DESIGN_EDITOR_WINDOWS_PUBLISHER}`)
  }
  return builder
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const requestedMode = process.argv[2]
  if (!['local', 'staging', 'production'].includes(requestedMode)) throw new Error('Package mode must be local, staging, or production.')

  const environmentFile = resolve(root, `.env.${requestedMode}`)
  if (!existsSync(environmentFile)) throw new Error(`Missing .env.${requestedMode}.`)

  const environment = createPackageEnvironment(process.env, parse(readFileSync(environmentFile)), requestedMode)
  const pnpm = environment.npm_execpath ?? environment.NPM_EXECPATH
  if (!pnpm) throw new Error('Run desktop packaging through pnpm.')

  function run(args) {
    const result = spawnSync(process.execPath, [pnpm, ...args], { cwd: root, env: environment, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed.`)
  }

  run(['--filter', '@canvas/desktop...', 'build'])
  run(createBuilderArguments(requestedMode, environment))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
