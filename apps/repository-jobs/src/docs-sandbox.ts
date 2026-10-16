import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { EngineOptions } from '@canvas/repo-engine'
import { createDockerContainerPort, type HostedPreviewContainerPort } from './hosted-sandbox.js'

const imagePattern = /^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._/-]{0,255}@sha256:[a-f0-9]{64})$/
const hashPattern = /^[a-f0-9]{64}$/
const profilePaths = Object.freeze([
  'package.json',
  'bun.lock',
  'apps/docs/package.json',
  'packages/design-system/package.json',
  'packages/tsconfig/package.json',
  'packages/tsconfig/base.json',
  'packages/tsconfig/react-library.json',
] as const)

export type HostedDocsValidationProfile = Readonly<{
  id: string
  hashes: Readonly<Record<(typeof profilePaths)[number], string>>
}>

export type HostedDocsValidator = NonNullable<EngineOptions['validateDocumentation']>

export function parseHostedDocsValidationProfile(input: unknown): HostedDocsValidationProfile {
  const value = record(input)
  if (!exactKeys(value, ['id', 'hashes']) || typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id)) {
    throw new Error('Hosted documentation validation profile is invalid.')
  }
  const hashes = record(value.hashes)
  if (!exactKeys(hashes, profilePaths) || profilePaths.some(path => typeof hashes[path] !== 'string' || !hashPattern.test(hashes[path] as string))) {
    throw new Error('Hosted documentation validation profile is invalid.')
  }
  return Object.freeze({
    id: value.id,
    hashes: Object.freeze(Object.fromEntries(profilePaths.map(path => [path, hashes[path] as string]))) as HostedDocsValidationProfile['hashes'],
  })
}

export function createDockerHostedDocsValidator(options: Readonly<{
  image: string
  profile: HostedDocsValidationProfile
  container?: HostedPreviewContainerPort
}>): HostedDocsValidator {
  if (!imagePattern.test(options.image)) throw new Error('Hosted documentation validator image must use an immutable digest.')
  const profile = parseHostedDocsValidationProfile(options.profile)
  const container = options.container ?? createDockerContainerPort()
  return async input => {
    const repositoryRoot = await canonicalDirectory(input.root)
    if (repositoryRoot.includes(',')) throw new Error('Hosted documentation sandbox path is invalid.')
    await verifyProfile(repositoryRoot, profile)
    const containerName = `canvas-docs-${randomUUID()}`
    const result = await container.run(Object.freeze({
      executable: 'docker',
      args: Object.freeze([
        'run', '--rm', '--interactive', '--pull=never', '--network=none', '--read-only',
        `--name=${containerName}`, '--stop-timeout=1',
        '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256',
        '--memory=2147483648', '--memory-swap=2147483648', '--cpus=2', '--ulimit=nofile=1024:1024',
        '--user=65532:65532', '--tmpfs=/tmp:rw,noexec,nosuid,size=268435456',
        '--tmpfs=/validator/repository:rw,noexec,nosuid,size=1073741824,mode=1777',
        `--mount=type=bind,source=${repositoryRoot},target=/workspace,readonly`,
        '--env=HOME=/tmp/home', '--env=CI=1', options.image,
      ]),
      stdin: JSON.stringify({ files: input.files, changedPaths: input.changedPaths, profile }),
      environment: Object.freeze({ PATH: process.env.PATH ?? '' }),
      timeoutMs: 180_000,
      maximumStdoutBytes: 16 * 1024,
      containerName,
    }))
    if (result.exitCode !== 0) throw new Error(`Hosted documentation sandbox failed: ${bounded(result.stderr)}`)
    parseResult(result.stdout, profile.id)
  }
}

async function verifyProfile(root: string, profile: HostedDocsValidationProfile): Promise<void> {
  for (const path of profilePaths) {
    const absolute = resolve(root, ...path.split('/'))
    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error('Hosted documentation validation profile is invalid.')
    let content: Buffer
    try { content = await readFile(absolute) }
    catch { throw new Error('Hosted documentation validation profile does not match the source.') }
    if (createHash('sha256').update(content).digest('hex') !== profile.hashes[path]) {
      throw new Error('Hosted documentation validation profile does not match the source.')
    }
  }
}

function parseResult(bytes: Uint8Array, profileId: string): void {
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new Error('Hosted documentation sandbox returned an invalid result.') }
  const result = record(value)
  if (!exactKeys(result, ['ok', 'profileId', 'phases']) || result.ok !== true || result.profileId !== profileId || !Array.isArray(result.phases) || result.phases.length !== 2 || result.phases[0] !== 'check' || result.phases[1] !== 'build') {
    throw new Error('Hosted documentation sandbox returned an invalid result.')
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(path)
  const info = await lstat(canonical)
  if (!info.isDirectory()) throw new Error('Hosted documentation sandbox directory is invalid.')
  return canonical
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Hosted documentation validation profile is invalid.')
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function bounded(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 512) || 'validator exited without diagnostics'
}
