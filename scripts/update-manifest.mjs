import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const versionPattern = /^\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?$/

function field(source, name) {
  const match = new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(source)
  return match?.[1]?.trim() ?? null
}

export function prepareUpdateManifest(source, options) {
  if (!versionPattern.test(options.expectedVersion)) throw new Error('The expected update version is invalid.')
  if (!Number.isInteger(options.rolloutPercentage) || options.rolloutPercentage < 0 || options.rolloutPercentage > 100) throw new Error('The rollout percentage must be an integer from 0 to 100.')
  const version = field(source, 'version')
  const path = field(source, 'path')
  const sha512 = field(source, 'sha512')
  if (version !== options.expectedVersion) throw new Error(`The update manifest version is ${version ?? 'missing'}, expected ${options.expectedVersion}.`)
  if (!path || basename(path) !== path || !path.endsWith('.exe')) throw new Error('The update manifest installer path is invalid.')
  if (!sha512 || !/^[A-Za-z0-9+/]{86}==$/.test(sha512)) throw new Error('The update manifest SHA-512 is invalid.')
  const actual = createHash('sha512').update(options.installerBytes).digest('base64')
  if (actual !== sha512) throw new Error('The update manifest SHA-512 does not match the installer.')
  const withoutRollout = source.replace(/^stagingPercentage:\s*.*(?:\r?\n|$)/m, '')
  return `${withoutRollout.trimEnd()}\nstagingPercentage: ${options.rolloutPercentage}\n`
}

export function setRolloutPercentage(source, percentage) {
  if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100) throw new Error('The rollout percentage must be an integer from 0 to 100.')
  if (!field(source, 'version') || !field(source, 'path') || !field(source, 'sha512')) throw new Error('The update manifest is incomplete.')
  return `${source.replace(/^stagingPercentage:\s*.*(?:\r?\n|$)/m, '').trimEnd()}\nstagingPercentage: ${percentage}\n`
}

function writeAtomic(path, value) {
  const temporary = resolve(dirname(path), `.${basename(path)}.next`)
  writeFileSync(temporary, value)
  renameSync(temporary, path)
}

function main() {
  const [command, manifestPath, value, installerPath] = process.argv.slice(2)
  if (!manifestPath || value === undefined) throw new Error('Usage: update-manifest.mjs prepare|rollout <manifest> <value> [installer].')
  const source = readFileSync(manifestPath, 'utf8')
  if (command === 'prepare') {
    if (!installerPath) throw new Error('Prepare requires an installer path.')
    writeAtomic(manifestPath, prepareUpdateManifest(source, { expectedVersion: value, rolloutPercentage: Number(process.env.UPDATE_ROLLOUT_PERCENTAGE ?? '100'), installerBytes: readFileSync(installerPath) }))
    return
  }
  if (command === 'rollout') {
    writeAtomic(manifestPath, setRolloutPercentage(source, Number(value)))
    return
  }
  throw new Error('Unknown update manifest command.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
