import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import {
  parseHostedPreviewArtifactManifest,
  verifyHostedPreviewArtifactFiles,
} from '@canvas/preview-runtime/hosted-artifact'
import type { HostedPreviewSandboxInput, HostedPreviewSandboxOutput, HostedPreviewSandboxPort } from './hosted-build.js'

export type ContainerCommand = Readonly<{
  executable: string
  args: readonly string[]
  stdin: string
  environment: Readonly<Record<string, string>>
  timeoutMs: number
  maximumStdoutBytes: number
  containerName: string
}>

export interface HostedPreviewContainerPort {
  run(command: ContainerCommand): Promise<Readonly<{ exitCode: number; stdout: Uint8Array; stderr: string }>>
}

type ForceRemoveContainer = (containerName: string, environment: Readonly<Record<string, string>>) => Promise<number>

const imagePattern = /^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._/-]{0,255}@sha256:[a-f0-9]{64})$/
const maximumErrorBytes = 16 * 1024
const maximumArtifactBytes = 64 * 1024 * 1024
const maximumEnvelopeBytes = 96 * 1024 * 1024
const outputTmpfsBytes = 80 * 1024 * 1024

export function createDockerHostedPreviewSandbox(options: Readonly<{
  image: string
  container?: HostedPreviewContainerPort
}>): HostedPreviewSandboxPort {
  if (!imagePattern.test(options.image)) throw new Error('Hosted preview builder image must use an immutable digest.')
  const container = options.container ?? createDockerContainerPort()
  return Object.freeze({
    async build(input: HostedPreviewSandboxInput): Promise<HostedPreviewSandboxOutput> {
      const repositoryRoot = await canonicalDirectory(input.repositoryRoot)
      if (repositoryRoot.includes(',')) throw new Error('Hosted preview sandbox path is invalid.')
      const contract = JSON.stringify({
        artifactId: input.artifactId,
        sourceRevision: input.sourceRevision,
        registryFingerprint: input.registryFingerprint,
        request: input.request,
      })
      const containerName = `canvas-hosted-${randomUUID()}`
      const result = await container.run(Object.freeze({
        executable: 'docker',
        args: Object.freeze([
          'run', '--rm', '--interactive', '--pull=never', '--network=none', '--read-only',
          `--name=${containerName}`, '--stop-timeout=1',
          '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256',
          '--memory=1073741824', '--cpus=2', '--user=65532:65532',
          '--tmpfs=/tmp:rw,noexec,nosuid,size=268435456',
          `--tmpfs=/output:rw,noexec,nosuid,size=${outputTmpfsBytes}`,
          `--mount=type=bind,source=${repositoryRoot},target=/workspace,readonly`,
          '--env=HOME=/tmp/home', '--env=CI=1', options.image,
        ]),
        stdin: contract,
        environment: Object.freeze({ PATH: process.env.PATH ?? '' }),
        timeoutMs: 120_000,
        maximumStdoutBytes: maximumEnvelopeBytes,
        containerName,
      }))
      if (result.exitCode !== 0) throw new Error(`Hosted preview sandbox failed: ${boundedMessage(result.stderr)}`)
      return parseSandboxEnvelope(result.stdout)
    },
  })
}

export function createDockerContainerPort(options: Readonly<{
  forceRemove?: ForceRemoveContainer
}> = {}): HostedPreviewContainerPort {
  const forceRemove = options.forceRemove ?? forceRemoveDockerContainer
  return Object.freeze({
    run(command: ContainerCommand) {
      return new Promise<Readonly<{ exitCode: number; stdout: Uint8Array; stderr: string }>>((resolveRun, rejectRun) => {
        const child = spawn(command.executable, [...command.args], {
          env: { ...command.environment },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let stdoutBytes = 0
        let stderrBytes = 0
        let processClosed = false
        let aborting = false
        let settled = false

        const finishError = (error: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          rejectRun(error)
        }
        const beginAbort = (error: Error) => {
          if (aborting || settled) return
          aborting = true
          clearTimeout(timeout)
          child.stdin.destroy()
          child.kill('SIGKILL')
          void (async () => {
            let cleanupError: unknown
            try {
              await waitForProcessClose(child, () => processClosed, 5_000)
            } catch (caught) {
              cleanupError = caught
            }
            try {
              const cleanupCode = await forceRemove(command.containerName, command.environment)
              if (cleanupCode !== 0) cleanupError ??= new Error(`Container removal returned ${cleanupCode}.`)
            } catch (caught) {
              cleanupError ??= caught
            }
            if (cleanupError) Object.defineProperty(error, 'cause', { value: cleanupError, configurable: true })
            finishError(error)
          })()
        }

        child.stdout.on('data', (chunk: Buffer) => {
          if (aborting || settled) return
          stdoutBytes += chunk.byteLength
          if (stdoutBytes > command.maximumStdoutBytes) {
            beginAbort(new Error('Hosted preview sandbox output exceeded the limit.'))
            return
          }
          stdout.push(chunk)
        })
        child.stderr.on('data', (chunk: Buffer) => {
          if (stderrBytes >= maximumErrorBytes) return
          const remaining = maximumErrorBytes - stderrBytes
          stderr.push(chunk.subarray(0, remaining))
          stderrBytes += Math.min(chunk.byteLength, remaining)
        })
        child.stdin.on('error', error => {
          if (!aborting && !processClosed) beginAbort(new Error('Hosted preview sandbox input failed.', { cause: error }))
        })
        child.once('error', error => {
          if (!aborting) finishError(error)
        })
        child.once('close', code => {
          processClosed = true
          if (aborting || settled) return
          settled = true
          clearTimeout(timeout)
          resolveRun(Object.freeze({
            exitCode: code ?? 1,
            stdout: new Uint8Array(Buffer.concat(stdout)),
            stderr: Buffer.concat(stderr).toString('utf8'),
          }))
        })
        const timeout = setTimeout(() => beginAbort(new Error('Hosted preview sandbox timed out.')), command.timeoutMs)
        child.stdin.end(command.stdin)
      })
    },
  })
}

function parseSandboxEnvelope(bytes: Uint8Array): HostedPreviewSandboxOutput {
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new Error('Hosted preview sandbox returned an invalid output envelope.') }
  if (!isRecord(value) || !hasExactKeys(value, ['manifest', 'files']) || !Array.isArray(value.files)) {
    throw new Error('Hosted preview sandbox returned an invalid output envelope.')
  }
  const manifest = parseHostedPreviewArtifactManifest(value.manifest)
  if (value.files.length !== manifest.files.length) throw new Error('Hosted preview sandbox returned an invalid output envelope.')
  const files = new Map<string, Uint8Array>()
  let totalBytes = 0
  for (const file of value.files) {
    if (!isRecord(file) || !hasExactKeys(file, ['path', 'base64']) || typeof file.path !== 'string' || typeof file.base64 !== 'string') {
      throw new Error('Hosted preview sandbox returned an invalid output envelope.')
    }
    const encoded = file.base64
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error('Hosted preview sandbox returned an invalid output envelope.')
    }
    const decoded = new Uint8Array(Buffer.from(encoded, 'base64'))
    if (Buffer.from(decoded).toString('base64') !== encoded || files.has(file.path)) {
      throw new Error('Hosted preview sandbox returned an invalid output envelope.')
    }
    totalBytes += decoded.byteLength
    if (totalBytes > maximumArtifactBytes) throw new Error('Hosted preview sandbox returned an invalid output envelope.')
    files.set(file.path, decoded)
  }
  verifyHostedPreviewArtifactFiles(manifest, files)
  return Object.freeze({ manifest, files })
}

async function forceRemoveDockerContainer(containerName: string, environment: Readonly<Record<string, string>>): Promise<number> {
  return new Promise<number>((resolveRemoval, rejectRemoval) => {
    const child = spawn('docker', ['rm', '--force', containerName], {
      env: { ...environment },
      windowsHide: true,
      stdio: 'ignore',
    })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.once('error', error => {
      clearTimeout(timeout)
      rejectRemoval(error)
    })
    child.once('exit', code => {
      clearTimeout(timeout)
      resolveRemoval(code ?? 1)
    })
  })
}

function waitForProcessClose(child: ReturnType<typeof spawn>, closed: () => boolean, timeoutMs: number): Promise<void> {
  if (closed()) return Promise.resolve()
  return new Promise<void>((resolveWait, rejectWait) => {
    const timeout = setTimeout(() => rejectWait(new Error('Hosted preview sandbox process did not terminate.')), timeoutMs)
    const done = () => {
      clearTimeout(timeout)
      resolveWait()
    }
    child.once('close', done)
  })
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(path)
  const info = await lstat(canonical)
  if (!info.isDirectory()) throw new Error('Hosted preview sandbox directory is invalid.')
  return canonical
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function boundedMessage(value: string): string {
  const message = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 512)
  return message || 'builder exited without diagnostics'
}
