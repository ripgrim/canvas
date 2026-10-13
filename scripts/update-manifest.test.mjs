import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { prepareUpdateManifest, setRolloutPercentage } from './update-manifest.mjs'

const installer = Buffer.from('signed installer fixture')
const hash = createHash('sha512').update(installer).digest('base64')
const manifest = `version: 1.2.3-nightly.20261013.41\nfiles:\n  - url: Comp Canvas Nightly Setup 1.2.3-nightly.20261013.41.exe\n    sha512: ${hash}\n    size: ${installer.length}\npath: Comp Canvas Nightly Setup 1.2.3-nightly.20261013.41.exe\nsha512: ${hash}\nreleaseDate: '2026-10-11T00:00:00.000Z'\n`

test('UPDATE-FEED-002 verifies bytes before setting a deterministic rollout', () => {
  const prepared = prepareUpdateManifest(manifest, { expectedVersion: '1.2.3-nightly.20261013.41', rolloutPercentage: 10, installerBytes: installer })
  assert.match(prepared, /stagingPercentage: 10\n$/)
  assert.equal((prepared.match(/stagingPercentage:/g) ?? []).length, 1)
  assert.match(setRolloutPercentage(prepared, 0), /stagingPercentage: 0\n$/)
  assert.match(setRolloutPercentage(prepared, 100), /stagingPercentage: 100\n$/)
})

test('UPDATE-FEED-002 refuses mismatched bytes, versions, and rollout injection', () => {
  assert.throws(() => prepareUpdateManifest(manifest, { expectedVersion: '1.2.4', rolloutPercentage: 10, installerBytes: installer }), /expected 1.2.4/)
  assert.throws(() => prepareUpdateManifest(manifest, { expectedVersion: '1.2.3-nightly.20261013.41', rolloutPercentage: 10, installerBytes: Buffer.from('tampered') }), /does not match/)
  assert.throws(() => prepareUpdateManifest(manifest, { expectedVersion: '1.2.3-nightly.41', rolloutPercentage: 10, installerBytes: installer }), /expected update version is invalid/)
  assert.throws(() => setRolloutPercentage(manifest, Number.NaN), /integer from 0 to 100/)
})
