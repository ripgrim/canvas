import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const owner = 'ripgrim'
const releaseBranches = new Set(['staging', 'main'])
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const shaPattern = /^[0-9a-f]{40}$/

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

export function evaluateReleasePolicy(input) {
  requireValue(input.actor === owner && input.triggeringActor === owner, 'Only ripgrim may trigger or rerun database migrations and releases.')
  requireValue(releaseBranches.has(input.branch), `Unsupported release branch: ${input.branch}.`)
  requireValue(shaPattern.test(input.sha), 'The release commit SHA is invalid.')
  requireValue(/^\d+$/.test(input.runNumber), 'The workflow run number is invalid.')
  requireValue(versionPattern.test(input.rootVersion) && input.rootVersion === input.desktopVersion, 'Root and desktop versions must match and use semantic versioning before release.')
  requireValue(Array.isArray(input.pulls), 'Associated pull requests are unavailable.')

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
  const version = staging ? `${input.rootVersion}-nightly.${input.runNumber}` : input.rootVersion
  return {
    channel: staging ? 'staging' : 'production',
    environment: staging ? 'staging' : 'production',
    tag: `v${version}`,
    version,
    title: staging ? `Comp Canvas Nightly ${input.rootVersion} (${shortSha})` : `Comp Canvas ${input.rootVersion}`,
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
    pulls: JSON.parse(process.env.ASSOCIATED_PULLS_JSON ?? '[]'),
  })

  for (const [name, value] of Object.entries(release)) process.stdout.write(`${name}=${value}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
