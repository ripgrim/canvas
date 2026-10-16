import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDockerHostedDocsValidator,
  parseHostedDocsValidationProfile,
  type HostedDocsValidationProfile,
} from '../src/docs-sandbox.js'
import type { ContainerCommand, HostedPreviewContainerPort } from '../src/hosted-sandbox.js'

const roots: string[] = []
const image = `registry.example/docs@sha256:${'a'.repeat(64)}`
const paths = [
  'package.json',
  'bun.lock',
  'apps/docs/package.json',
  'packages/design-system/package.json',
  'packages/tsconfig/package.json',
  'packages/tsconfig/base.json',
  'packages/tsconfig/react-library.json',
] as const

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<Readonly<{ root: string; profile: HostedDocsValidationProfile }>> {
  const root = await mkdtemp(join(tmpdir(), 'canvas-docs-sandbox-'))
  roots.push(root)
  const hashes: Record<string, string> = {}
  for (const path of paths) {
    const content = `${path}\n`
    const target = join(root, ...path.split('/'))
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
    hashes[path] = createHash('sha256').update(content).digest('hex')
  }
  return { root, profile: parseHostedDocsValidationProfile({ id: 'comp-v3-blume-v1', hashes }) }
}

function container(result: Readonly<{ exitCode?: number; stdout?: string; stderr?: string }> = {}): Readonly<{ port: HostedPreviewContainerPort; calls: ContainerCommand[] }> {
  const calls: ContainerCommand[] = []
  return {
    calls,
    port: {
      run: vi.fn(async command => {
        calls.push(command)
        return {
          exitCode: result.exitCode ?? 0,
          stdout: new TextEncoder().encode(result.stdout ?? JSON.stringify({ ok: true, profileId: 'comp-v3-blume-v1', phases: ['check', 'build'] })),
          stderr: result.stderr ?? '',
        }
      }),
    },
  }
}

describe('hosted documentation sandbox', () => {
  it('COMP-V2-DOCS-006 runs a digest-pinned, networkless and read-only validator', async () => {
    const source = await fixture()
    const fake = container()
    const validate = createDockerHostedDocsValidator({ image, profile: source.profile, container: fake.port })

    await validate({ root: source.root, files: { 'apps/docs/content/docs/button.mdx': '# Button\n' }, changedPaths: ['apps/docs/content/docs/button.mdx'] })

    expect(fake.calls).toHaveLength(1)
    const command = fake.calls[0]!
    expect(command.args).toContain('--network=none')
    expect(command.args).toContain('--read-only')
    expect(command.args).toContain('--cap-drop=ALL')
    expect(command.args).toContain('--security-opt=no-new-privileges')
    expect(command.args).toContain('--memory=2147483648')
    expect(command.args).toContain('--memory-swap=2147483648')
    expect(command.args).toContain('--ulimit=nofile=1024:1024')
    expect(command.args).toContain('--tmpfs=/validator/repository:rw,noexec,nosuid,size=1073741824,mode=1777')
    expect(command.args.at(-1)).toBe(image)
    expect(command.environment).toEqual({ PATH: process.env.PATH ?? '' })
    expect(JSON.parse(command.stdin)).toEqual({
      files: { 'apps/docs/content/docs/button.mdx': '# Button\n' },
      changedPaths: ['apps/docs/content/docs/button.mdx'],
      profile: source.profile,
    })
  })

  it('COMP-V2-DOCS-006 rejects mutable image tags', async () => {
    const source = await fixture()
    expect(() => createDockerHostedDocsValidator({ image: 'canvas/docs:latest', profile: source.profile })).toThrow('immutable digest')
  })

  it('COMP-V2-DOCS-006 rejects source dependency drift before starting the container', async () => {
    const source = await fixture()
    const fake = container()
    await writeFile(join(source.root, 'bun.lock'), 'changed\n')
    const validate = createDockerHostedDocsValidator({ image, profile: source.profile, container: fake.port })

    await expect(validate({ root: source.root, files: {}, changedPaths: [] })).rejects.toThrow('does not match the source')
    expect(fake.calls).toHaveLength(0)
  })

  it('COMP-V2-DOCS-006 rejects incomplete validator evidence', async () => {
    const source = await fixture()
    const fake = container({ stdout: JSON.stringify({ ok: true, profileId: 'comp-v3-blume-v1', phases: ['build'] }) })
    const validate = createDockerHostedDocsValidator({ image, profile: source.profile, container: fake.port })

    await expect(validate({ root: source.root, files: {}, changedPaths: [] })).rejects.toThrow('invalid result')
  })

  it('COMP-V2-DOCS-006 surfaces bounded validator failures', async () => {
    const source = await fixture()
    const fake = container({ exitCode: 1, stderr: `bad\n${'x'.repeat(1_000)}` })
    const validate = createDockerHostedDocsValidator({ image, profile: source.profile, container: fake.port })

    await expect(validate({ root: source.root, files: {}, changedPaths: [] })).rejects.toThrow(/^Hosted documentation sandbox failed: bad /)
  })
})
