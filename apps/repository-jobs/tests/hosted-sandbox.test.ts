import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDockerContainerPort, createDockerHostedPreviewSandbox } from '../src/hosted-sandbox.js'
import type { HostedPreviewContainerPort } from '../src/hosted-sandbox.js'

const image = `canvas-hosted-builder@sha256:${'a'.repeat(64)}`
const artifactId = '00000000-0000-4000-8000-000000000401'
const sourceRevision = 'b'.repeat(40)
const registryFingerprint = `sha256:${'c'.repeat(64)}`
const componentId = 'shadcn:Button:8f9171d59b1041d3'
const sourceHash = 'd'.repeat(64)
const request = Object.freeze({
  version: 1 as const,
  entry: Object.freeze({ componentId }),
  components: Object.freeze([Object.freeze({
    componentId,
    entryPath: 'src/button.tsx',
    exportName: 'Button',
    integrity: `sha256-${Buffer.from(sourceHash, 'hex').toString('base64')}`,
    props: Object.freeze({}),
    slots: Object.freeze([]),
  })]),
  styles: Object.freeze([]),
})
const manifest = Object.freeze({
  version: 1 as const,
  sourceRevision,
  registryFingerprint,
  entrypoint: 'index.html',
  files: Object.freeze([
    Object.freeze({ path: 'index.html', sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', bytes: 5, contentType: 'text/html; charset=utf-8' as const }),
    Object.freeze({ path: 'assets/components.js', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', bytes: 0, contentType: 'text/javascript; charset=utf-8' as const }),
  ]),
  components: Object.freeze([Object.freeze({ componentId, modulePath: 'assets/components.js', exportName: 'Button' })]),
})

function envelope(files: ReadonlyArray<Readonly<{ path: string; bytes: Uint8Array }>>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    manifest,
    files: files.map(file => ({ path: file.path, base64: Buffer.from(file.bytes).toString('base64') })),
  }))
}

describe('hosted preview Docker sandbox', () => {
  it('COMP-V2-CODE-010 uses a pinned, networkless, read-only container with bounded output transport', async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), 'canvas-sandbox-repository-'))
    const run = vi.fn<HostedPreviewContainerPort['run']>(async () => ({
      exitCode: 0,
      stdout: envelope([
        { path: 'index.html', bytes: new TextEncoder().encode('hello') },
        { path: 'assets/components.js', bytes: new Uint8Array() },
      ]),
      stderr: '',
    }))
    const sandbox = createDockerHostedPreviewSandbox({ image, container: { run } })

    await expect(sandbox.build({ artifactId, repositoryRoot, sourceRevision, registryFingerprint, request })).resolves.toEqual({
      manifest,
      files: new Map([
        ['index.html', new TextEncoder().encode('hello')],
        ['assets/components.js', new Uint8Array()],
      ]),
    })

    const command = run.mock.calls[0]![0]
    expect(command.executable).toBe('docker')
    expect(command.args).toEqual(expect.arrayContaining([
      'run', '--rm', '--interactive', '--pull=never', '--network=none', '--read-only',
      '--stop-timeout=1', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--pids-limit=256', '--memory=1073741824', '--cpus=2', '--user=65532:65532', image,
    ]))
    expect(command.args.some(value => value.startsWith('--name=canvas-hosted-'))).toBe(true)
    expect(command.args).toContain('--tmpfs=/output:rw,noexec,nosuid,size=83886080')
    expect(command.args.some(value => value.includes(`source=${repositoryRoot}`) && value.endsWith('target=/workspace,readonly'))).toBe(true)
    expect(command.args.some(value => value.includes('target=/output'))).toBe(false)
    expect(command.maximumStdoutBytes).toBe(96 * 1024 * 1024)
    expect(command.environment).toEqual({ PATH: process.env.PATH ?? '' })
    expect(JSON.parse(command.stdin)).toEqual({ artifactId, sourceRevision, registryFingerprint, request })
    expect(command.stdin).not.toContain(repositoryRoot)
    expect(command.stdin).not.toContain('token')
  })

  it('COMP-V2-CODE-010 rejects mutable images, failed builds, and malformed output envelopes', async () => {
    expect(() => createDockerHostedPreviewSandbox({ image: 'canvas-hosted-builder:latest' })).toThrow('immutable digest')
    const repositoryRoot = await mkdtemp(join(tmpdir(), 'canvas-sandbox-repository-'))
    const failed = createDockerHostedPreviewSandbox({
      image,
      container: { async run() { return { exitCode: 1, stdout: new Uint8Array(), stderr: 'builder exploded\nsecret-looking trailing output' } } },
    })
    await expect(failed.build({ artifactId, repositoryRoot, sourceRevision, registryFingerprint, request })).rejects.toThrow('builder exploded secret-looking trailing output')

    const malformed = createDockerHostedPreviewSandbox({
      image,
      container: { async run() { return { exitCode: 0, stdout: new TextEncoder().encode(JSON.stringify({ manifest, files: [{ path: 'index.html', base64: '***' }] })), stderr: '' } } },
    })
    await expect(malformed.build({ artifactId, repositoryRoot, sourceRevision, registryFingerprint, request })).rejects.toThrow('invalid output envelope')
  })

  it('COMP-V2-CODE-010 delivers stdin and captures stdout through the process boundary', async () => {
    const port = createDockerContainerPort({ forceRemove: async () => 0 })
    const result = await port.run({
      executable: process.execPath,
      args: ['-e', "process.stdin.on('data', value => process.stdout.write(value))"],
      stdin: 'canonical-contract',
      environment: { PATH: process.env.PATH ?? '' },
      timeoutMs: 5_000,
      maximumStdoutBytes: 1024,
      containerName: 'stdin-boundary-test',
    })
    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stdout)).toBe('canonical-contract')
  })

  it('COMP-V2-CODE-010 drains a fast-exit multi-megabyte output before resolving', async () => {
    const port = createDockerContainerPort({ forceRemove: async () => 0 })
    const expectedBytes = 2 * 1024 * 1024
    const result = await port.run({
      executable: process.execPath,
      args: ['-e', `process.stdout.write(Buffer.alloc(${expectedBytes}, 120))`],
      stdin: '',
      environment: { PATH: process.env.PATH ?? '' },
      timeoutMs: 5_000,
      maximumStdoutBytes: 4 * 1024 * 1024,
      containerName: 'pipe-drain-test',
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.byteLength).toBe(expectedBytes)
    expect(result.stdout.every(byte => byte === 120)).toBe(true)
  })

  it('COMP-V2-CODE-010 force-removes and waits for a timed-out container process', async () => {
    const markerRoot = await mkdtemp(join(tmpdir(), 'canvas-sandbox-process-'))
    const markerPath = join(markerRoot, 'pid')
    let processAliveDuringRemoval = true
    const forceRemove = vi.fn(async () => {
      const pid = Number(await readFile(markerPath, 'utf8'))
      try { process.kill(pid, 0) } catch { processAliveDuringRemoval = false }
      return 0
    })
    const port = createDockerContainerPort({ forceRemove })
    const startedAt = Date.now()
    await expect(port.run({
      executable: process.execPath,
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(markerPath)}, String(process.pid)); setInterval(() => {}, 1000)`],
      stdin: '',
      environment: { PATH: process.env.PATH ?? '' },
      timeoutMs: 250,
      maximumStdoutBytes: 1024,
      containerName: 'timeout-boundary-test',
    })).rejects.toThrow('timed out')
    expect(forceRemove).toHaveBeenCalledWith('timeout-boundary-test', { PATH: process.env.PATH ?? '' })
    expect(processAliveDuringRemoval).toBe(false)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it('COMP-V2-CODE-010 force-removes a container before rejecting oversized stdout', async () => {
    const forceRemove = vi.fn(async () => 0)
    const port = createDockerContainerPort({ forceRemove })
    await expect(port.run({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(64)); setInterval(() => {}, 1000)"],
      stdin: '',
      environment: { PATH: process.env.PATH ?? '' },
      timeoutMs: 5_000,
      maximumStdoutBytes: 32,
      containerName: 'output-boundary-test',
    })).rejects.toThrow('output exceeded the limit')
    expect(forceRemove).toHaveBeenCalledOnce()
  })
})
