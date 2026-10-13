import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const owner = 'ripgrim'
const releaseBranches = new Set(['staging', 'main'])
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const shaPattern = /^[0-9a-f]{40}$/

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function versionParts(version) {
  const match = versionPattern.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

function nextPatch(parts) {
  requireValue(parts[2] < Number.MAX_SAFE_INTEGER, 'The release patch version cannot be incremented safely.')
  return [parts[0], parts[1], parts[2] + 1]
}

const formatVersion = parts => parts.join('.')

export function nextReleaseVersion(baseVersion, existingTags) {
  const base = versionParts(baseVersion)
  requireValue(base, 'The application version must be stable semantic versioning before release.')
  requireValue(Array.isArray(existingTags) && existingTags.every(tag => typeof tag === 'string'), 'Existing release tags are unavailable.')
  const stable = existingTags
    .map(tag => tag.startsWith('v') ? versionParts(tag.slice(1)) : null)
    .filter(Boolean)
    .sort(compareVersions)
    .at(-1)
  return formatVersion(stable && compareVersions(base, stable) <= 0 ? nextPatch(stable) : base)
}

function nextNightlyNumber(version, runNumber, existingTags) {
  const floor = Number(runNumber)
  requireValue(Number.isSafeInteger(floor) && floor > 0, 'The workflow run number is invalid.')
  const prefix = `v${version}-nightly.`
  const latest = existingTags.reduce((maximum, tag) => {
    if (!tag.startsWith(prefix)) return maximum
    const value = tag.slice(prefix.length)
    return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Math.max(maximum, Number(value)) : maximum
  }, 0)
  requireValue(latest < Number.MAX_SAFE_INTEGER, 'The nightly release number cannot be incremented safely.')
  return Math.max(floor, latest + 1)
}

export function evaluateReleasePolicy(input) {
  requireValue(input.actor === owner && input.triggeringActor === owner, 'Only ripgrim may trigger or rerun database migrations and releases.')
  requireValue(releaseBranches.has(input.branch), `Unsupported release branch: ${input.branch}.`)
  requireValue(shaPattern.test(input.sha), 'The release commit SHA is invalid.')
  requireValue(/^\d+$/.test(input.runNumber), 'The workflow run number is invalid.')
  requireValue(versionPattern.test(input.rootVersion) && input.rootVersion === input.desktopVersion, 'Root and desktop versions must match and use semantic versioning before release.')
  requireValue(Array.isArray(input.pulls), 'Associated pull requests are unavailable.')
  requireValue(Array.isArray(input.existingTags), 'Existing release tags are unavailable.')

  const pull = input.pulls
    .filter(candidate => candidate?.merged_at && candidate?.base?.ref === input.branch)
    .sort((left, right) => Date.parse(left.merged_at) - Date.parse(right.merged_at))
    .at(-1)

  requireValue(pull, `The branch update is not associated with a merged pull request into ${input.branch}.`)
  requireValue(Number.isSafeInteger(pull.number) && pull.number > 0, 'The associated pull request number is invalid.')
  if (input.branch === 'main') {
    requireValue(pull.head?.ref === 'staging', 'Production releases must come from the staging branch.')
  }

  const shortSha = input.sha.slice(0, 7)
  const staging = input.branch === 'staging'
  const releaseVersion = nextReleaseVersion(input.rootVersion, input.existingTags)
  const version = staging ? `${releaseVersion}-nightly.${nextNightlyNumber(releaseVersion, input.runNumber, input.existingTags)}` : releaseVersion
  return {
    channel: staging ? 'staging' : 'production',
    environment: staging ? 'staging' : 'production',
    sha: input.sha,
    tag: `v${version}`,
    version,
    title: staging ? `Comp Canvas Nightly ${releaseVersion} (${shortSha})` : `Comp Canvas ${releaseVersion}`,
    pull_request: String(pull.number),
  }
}

function readPackageVersion(path) {
  return JSON.parse(readFileSync(path, 'utf8')).version
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const release = evaluateReleasePolicy({
    actor: process.env.GITHUB_ACTOR ?? '',
    triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR ?? '',
    branch: process.env.GITHUB_REF_NAME ?? '',
    sha: process.env.GITHUB_SHA ?? '',
    runNumber: process.env.GITHUB_RUN_NUMBER ?? '',
    rootVersion: readPackageVersion(resolve(root, 'package.json')),
    desktopVersion: readPackageVersion(resolve(root, 'apps/desktop/package.json')),
    existingTags: (process.env.EXISTING_RELEASE_TAGS ?? '').split(/\r?\n/).filter(Boolean),
    pulls: process.env.PULL_REQUEST_JSON ? [JSON.parse(process.env.PULL_REQUEST_JSON)] : JSON.parse(process.env.ASSOCIATED_PULLS_JSON ?? '[]'),
  })

  for (const [name, value] of Object.entries(release)) process.stdout.write(`${name}=${value}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
