import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { resolveFixtureGrant } from '../src/main/fixture-grant'

const temporary: string[] = []
afterEach(async () => { for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }) })

it('requires both smoke gates and disallows overrides in packaged builds', async () => {
  const fixed = await mkdtemp(join(tmpdir(), 'design-editor-fixed-'))
  const override = await mkdtemp(join(tmpdir(), 'design-editor-smoke-grant-'))
  temporary.push(fixed, override)
  const base = { defaultRoot: fixed, argv: [], smokeEnabled: false, packaged: false }
  expect(await resolveFixtureGrant(base)).toBe(await realpath(fixed))
  expect(await resolveFixtureGrant({ ...base, smokeEnabled: true })).toBe(await realpath(fixed))
  const argv = [`--smoke-fixture-root=${override}`]
  await expect(resolveFixtureGrant({ ...base, argv })).rejects.toThrow('not enabled')
  await expect(resolveFixtureGrant({ ...base, argv, smokeEnabled: true, packaged: true })).rejects.toThrow('not enabled')
  expect(await resolveFixtureGrant({ ...base, argv, smokeEnabled: true })).toBe(await realpath(override))
  await expect(resolveFixtureGrant({ ...base, argv: [`--smoke-fixture-root=${tmpdir()}`], smokeEnabled: true })).rejects.toThrow('dedicated temporary directory')
  await expect(resolveFixtureGrant({ ...base, argv: ['--smoke-fixture-root=../fixture'], smokeEnabled: true })).rejects.toThrow('absolute path')
})
