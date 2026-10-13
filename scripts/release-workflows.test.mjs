import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBuilderArguments, createPackageEnvironment } from './package-desktop.mjs'
import { evaluateReleasePolicy, nextReleaseVersion } from './release-policy.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pullRequestWorkflow = await readFile(resolve(root, '.github/workflows/desktop-build.yml'), 'utf8')
const releaseWorkflow = await readFile(resolve(root, '.github/workflows/release.yml'), 'utf8')
const databasePackage = JSON.parse(await readFile(resolve(root, 'packages/database/package.json'), 'utf8'))
const stagingTemplate = await readFile(resolve(root, '.env.staging.example'), 'utf8')
const productionTemplate = await readFile(resolve(root, '.env.production.example'), 'utf8')

test('RELEASE-SECURITY-001 keeps secrets and migrations out of pull request builds', () => {
  assert.match(pullRequestWorkflow, /pull_request:[\s\S]*- staging[\s\S]*- main/)
  assert.match(pullRequestWorkflow, /Validate database migrations/)
  assert.match(pullRequestWorkflow, /Build unsigned desktop installer/)
  assert.match(pullRequestWorkflow, /Smoke packaged main process[\s\S]*test:packaged-launch-smoke/)
  assert.doesNotMatch(pullRequestWorkflow, /secrets\.|DATABASE_URL|\bmigrate\b/)
})

const releaseInput = {
  actor: 'ripgrim',
  triggeringActor: 'ripgrim',
  branch: 'staging',
  sha: 'a'.repeat(40),
  runNumber: '41',
  startedAt: '2026-10-11T12:34:56Z',
  rootVersion: '0.1.0',
  desktopVersion: '0.1.0',
  existingTags: [],
  pulls: [{ number: 73, merged_at: '2026-10-11T12:00:00Z', base: { ref: 'staging' }, head: { ref: 'feature/mobile' } }],
}

test('RELEASE-SECURITY-002 accepts only an owner-triggered merged pull request', () => {
  assert.match(releaseWorkflow, /pull_request:[\s\S]*- staging[\s\S]*- main[\s\S]*- closed/)
  assert.match(releaseWorkflow, /github\.event\.pull_request\.merged == true/)
  assert.match(releaseWorkflow, /node scripts\/release-policy\.mjs/)
  assert.match(releaseWorkflow, /EXISTING_RELEASE_TAGS="\$tags"/)

  assert.deepEqual(evaluateReleasePolicy(releaseInput), {
    channel: 'staging',
    release_channel: 'nightly',
    environment: 'staging',
    prerelease: 'true',
    make_latest: 'false',
    sha: 'a'.repeat(40),
    tag: 'v0.1.0-nightly.20261011.41',
    version: '0.1.0-nightly.20261011.41',
    title: `Comp Canvas Nightly 0.1.0-nightly.20261011.41 (${'a'.repeat(7)})`,
    pull_request: '73',
  })
})

test('RELEASE-SECURITY-003 rejects unauthorized, direct, and wrong-source releases', () => {
  assert.throws(() => evaluateReleasePolicy({ ...releaseInput, actor: 'collaborator' }), /Only ripgrim/)
  assert.throws(() => evaluateReleasePolicy({ ...releaseInput, pulls: [] }), /not associated with a merged pull request/)
  assert.throws(() => evaluateReleasePolicy({ ...releaseInput, startedAt: 'not-a-date' }), /workflow start time is invalid/)
  assert.throws(() => evaluateReleasePolicy({
    ...releaseInput,
    branch: 'main',
    pulls: [{ number: 74, merged_at: '2026-10-11T13:00:00Z', base: { ref: 'main' }, head: { ref: 'feature/bypass' } }],
  }), /must come from the staging branch/)
  assert.throws(() => evaluateReleasePolicy({ ...releaseInput, rootVersion: '0.1.0\nchannel=production' }), /semantic versioning/)
})

test('RELEASE-PIPELINE-001 gates publication on channel migration and the merged build', () => {
  assert.match(releaseWorkflow, /node scripts\/release-policy\.mjs/)
  assert.match(releaseWorkflow, /environment: \$\{\{ needs\.authorize\.outputs\.environment \}\}/)
  assert.match(releaseWorkflow, /DATABASE_URL: \$\{\{ secrets\.DATABASE_URL \}\}/)
  assert.doesNotMatch(releaseWorkflow, /STAGING_DATABASE_URL|PRODUCTION_DATABASE_URL/)
  assert.match(releaseWorkflow, /name: Apply database migrations[\s\S]*pnpm --filter @canvas\/database migrate/)
  assert.match(releaseWorkflow, /name: Publish[\s\S]*needs:[\s\S]*- build[\s\S]*- migrate/)
  assert.match(releaseWorkflow, /--prerelease/)
  assert.match(releaseWorkflow, /release_channel: \$\{\{ steps\.release\.outputs\.release_channel \}\}/)
  assert.match(releaseWorkflow, /--latest="\$RELEASE_MAKE_LATEST"/)
  assert.match(releaseWorkflow, /Select signing mode/)
  assert.match(releaseWorkflow, /WINDOWS_CERTIFICATE/)
  assert.match(releaseWorkflow, /Windows signing is partially configured/)
  assert.match(releaseWorkflow, /DESIGN_EDITOR_UPDATABLE=\$enabled/)
  assert.match(releaseWorkflow, /Smoke packaged main process[\s\S]*test:packaged-launch-smoke/)
  assert.match(releaseWorkflow, /Unsigned manual-download build\. Automatic updates are intentionally disabled/)
  assert.match(releaseWorkflow, /Require update publishing credentials/)
  assert.match(releaseWorkflow, /if: needs\.build\.outputs\.updatable == 'true'/)
  assert.ok(releaseWorkflow.indexOf('Publish GitHub release') < releaseWorkflow.indexOf('Advance update channel'))

  const production = evaluateReleasePolicy({
    ...releaseInput,
    branch: 'main',
    pulls: [{ number: 75, merged_at: '2026-10-11T14:00:00Z', base: { ref: 'main' }, head: { ref: 'staging' } }],
  })
  assert.equal(production.channel, 'production')
  assert.equal(production.release_channel, 'stable')
  assert.equal(production.prerelease, 'false')
  assert.equal(production.make_latest, 'true')
  assert.equal(production.tag, 'v0.1.0')
  assert.equal(production.version, '0.1.0')
})

test('UPDATE-FEED-001 promotes occupied tags to one monotonic release version', () => {
  const tags = ['v0.1.0', 'v0.1.1', 'v0.1.2-nightly.41', 'not-a-release']
  assert.equal(nextReleaseVersion('0.1.1', tags), '0.1.2')
  assert.equal(nextReleaseVersion('0.2.0', tags), '0.2.0')

  const nightly = evaluateReleasePolicy({ ...releaseInput, rootVersion: '0.1.1', desktopVersion: '0.1.1', existingTags: tags })
  assert.equal(nightly.tag, 'v0.1.2-nightly.20261011.41')
  assert.equal(nightly.version, '0.1.2-nightly.20261011.41')
  assert.equal(nightly.title, `Comp Canvas Nightly 0.1.2-nightly.20261011.41 (${'a'.repeat(7)})`)

  const production = evaluateReleasePolicy({
    ...releaseInput,
    branch: 'main',
    rootVersion: '0.1.1',
    desktopVersion: '0.1.1',
    existingTags: tags,
    pulls: [{ number: 75, merged_at: '2026-10-11T14:00:00Z', base: { ref: 'main' }, head: { ref: 'staging' } }],
  })
  assert.equal(production.tag, 'v0.1.2')
  assert.equal(production.version, '0.1.2')
})

test('RELEASE-PIPELINE-002 builds migration workspace dependencies on a clean runner', () => {
  assert.equal(
    databasePackage.scripts.migrate,
    'pnpm --filter @canvas/database... build && node dist/migrate.js',
  )
})

test('RELEASE-DESKTOP-001 packages staging and production with isolated public origins', () => {
  const staging = Object.fromEntries(stagingTemplate.trim().split(/\r?\n/).map(line => line.split('=').map(value => value.replace(/^"|"$/g, ''))))
  const production = Object.fromEntries(productionTemplate.trim().split(/\r?\n/).map(line => line.split('=').map(value => value.replace(/^"|"$/g, ''))))
  const stagingEnvironment = createPackageEnvironment({ PATH: 'test', npm_execpath: 'pnpm.cjs' }, staging, 'staging')
  const productionEnvironment = createPackageEnvironment({ PATH: 'test', npm_execpath: 'pnpm.cjs' }, production, 'production')

  assert.equal(stagingEnvironment.DESIGN_EDITOR_PACKAGE_MODE, 'staging')
  assert.equal(stagingEnvironment.VITE_APP_URL, 'https://staging.canvas.ripgrim.com')
  assert.equal(stagingEnvironment.DESIGN_EDITOR_LOGIN_URL, 'https://login-staging.canvas.ripgrim.com')
  assert.equal(productionEnvironment.DESIGN_EDITOR_PACKAGE_MODE, 'production')
  assert.equal(productionEnvironment.VITE_APP_URL, 'https://canvas.ripgrim.com')
  assert.equal(productionEnvironment.DESIGN_EDITOR_LOGIN_URL, 'https://login.canvas.ripgrim.com')
  assert.equal(stagingEnvironment.DATABASE_URL, undefined)
  assert.equal(productionEnvironment.DATABASE_URL, undefined)
  assert.equal(stagingEnvironment.DESIGN_EDITOR_UPDATE_URL, 'https://updates-staging.canvas.ripgrim.com/windows/x64')
  assert.equal(productionEnvironment.DESIGN_EDITOR_UPDATE_URL, 'https://updates.canvas.ripgrim.com/windows/x64')
})

test('RELEASE-DESKTOP-002 keeps previews out of update feeds and isolates nightly metadata', () => {
  const preview = createBuilderArguments('staging', { DESIGN_EDITOR_UPDATE_URL: 'https://updates.test' })
  assert.equal(preview.some(value => value.includes('publish.provider')), false)
  assert.equal(preview.some(value => value.includes('extraMetadata.version')), false)

  const unsignedNightly = createBuilderArguments('staging', { DESIGN_EDITOR_RELEASE_VERSION: '0.1.0-nightly.41', DESIGN_EDITOR_UPDATE_URL: 'https://updates.test' })
  assert.ok(unsignedNightly.includes('--config.extraMetadata.version=0.1.0-nightly.41'))
  assert.ok(unsignedNightly.includes('--config.appId=com.comp-canvas.desktop.nightly'))
  assert.equal(unsignedNightly.some(value => value.includes('publish.provider')), false)

  const nightly = createBuilderArguments('staging', { DESIGN_EDITOR_UPDATABLE: '1', DESIGN_EDITOR_RELEASE_VERSION: '0.1.0-nightly.41', DESIGN_EDITOR_UPDATE_URL: 'https://updates.test', DESIGN_EDITOR_WINDOWS_PUBLISHER: 'Comp Canvas, LLC' })
  assert.ok(nightly.includes('--config.extraMetadata.version=0.1.0-nightly.41'))
  assert.ok(nightly.includes('--config.publish.channel=nightly'))
  assert.ok(nightly.includes('--config.appId=com.comp-canvas.desktop.nightly'))
  assert.ok(nightly.includes('--config.win.publisherName=Comp Canvas, LLC'))
})
