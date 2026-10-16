import { createHash } from 'node:crypto'
import type { BlumeDocsAdapter } from './component-docs-adapter.js'
import { parseBlumeDocsAdapter } from './component-docs-adapter.js'

export type HostedDocsReviewFile = Readonly<{
  path: string
  beforeSha256: string | null
  after: string | null
  diff: string
}>

export type HostedDocsReviewBundle = Readonly<{
  version: 1
  projectId: string
  fileId: string
  fileRevision: number
  fileDocumentSha256: string
  scanJobId: string
  installationId: string
  repositoryId: string
  repositoryGrantId: string
  repositoryLinkedAt: number
  baseRef: string
  baseCommitSha: string
  baseTreeSha: string
  adapter: BlumeDocsAdapter
  files: readonly HostedDocsReviewFile[]
  omissions: readonly Readonly<{ componentId: string; reason: 'example-adapter-required' | 'usage-adapter-required' }>[]
  validation: readonly Readonly<{ name: string; detail: string }>[]
}>

export type HostedDocsReview = Readonly<{ bundle: HostedDocsReviewBundle; approvalDigest: string }>

const maximumFiles = 500
const maximumBytes = 5 * 1024 * 1024
const sha256 = /^[a-f0-9]{64}$/
const gitSha = /^[a-f0-9]{40}$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const opaque = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const githubId = /^[1-9][0-9]{0,31}$/
const safePath = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\u0000-\u001f\u007f]{1,512}$/u
const branchRef = /^refs\/heads\/(?!.*(?:^|\/)\.\.?$)[A-Za-z0-9][A-Za-z0-9._\/-]{0,254}$/
const componentId = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/

const invalid = (): never => { throw new Error('Invalid hosted documentation review') }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const exact = (value: unknown, required: readonly string[]): Record<string, unknown> => {
  if (!isRecord(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key))) invalid()
  return value as Record<string, unknown>
}
const text = (value: unknown, maximum: number, pattern?: RegExp): string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || pattern && !pattern.test(value)) invalid()
  return value as string
}
const integer = (value: unknown): number => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : invalid()
const list = <T>(value: unknown, maximum: number, parse: (entry: unknown) => T): readonly T[] => Array.isArray(value) && value.length <= maximum ? Object.freeze(value.map(parse)) : invalid()

export function parseHostedDocsReviewBundle(input: unknown): HostedDocsReviewBundle {
  const value = exact(input, ['version', 'projectId', 'fileId', 'fileRevision', 'fileDocumentSha256', 'scanJobId', 'installationId', 'repositoryId', 'repositoryGrantId', 'repositoryLinkedAt', 'baseRef', 'baseCommitSha', 'baseTreeSha', 'adapter', 'files', 'omissions', 'validation'])
  if (value.version !== 1) invalid()
  const files = list(value.files, maximumFiles, entry => {
    const file = exact(entry, ['path', 'beforeSha256', 'after', 'diff'])
    const beforeSha256 = file.beforeSha256 === null ? null : text(file.beforeSha256, 64, sha256)
    const after = file.after === null ? null : text(file.after, maximumBytes)
    return Object.freeze({ path: text(file.path, 512, safePath), beforeSha256, after, diff: text(file.diff, maximumBytes) })
  })
  if (files.length === 0 || new Set(files.map(file => file.path.toLocaleLowerCase('en-US'))).size !== files.length) invalid()
  const omissions = list(value.omissions, maximumFiles, entry => {
    const omission = exact(entry, ['componentId', 'reason'])
    if (omission.reason !== 'example-adapter-required' && omission.reason !== 'usage-adapter-required') invalid()
    return Object.freeze({ componentId: text(omission.componentId, 128, componentId), reason: omission.reason as 'example-adapter-required' | 'usage-adapter-required' })
  })
  const validation = list(value.validation, 32, entry => {
    const check = exact(entry, ['name', 'detail'])
    return Object.freeze({ name: text(check.name, 100), detail: text(check.detail, 2_000) })
  })
  if (validation.length === 0 || new Set(validation.map(check => check.name)).size !== validation.length) invalid()
  const byteCount = files.reduce((total, file) => total + Buffer.byteLength(file.after ?? '', 'utf8') + Buffer.byteLength(file.diff, 'utf8'), 0)
  if (byteCount > maximumBytes) invalid()
  return Object.freeze({
    version: 1,
    projectId: text(value.projectId, 200, opaque),
    fileId: text(value.fileId, 36, uuid),
    fileRevision: integer(value.fileRevision),
    fileDocumentSha256: text(value.fileDocumentSha256, 64, sha256),
    scanJobId: text(value.scanJobId, 36, uuid),
    installationId: text(value.installationId, 32, githubId),
    repositoryId: text(value.repositoryId, 32, githubId),
    repositoryGrantId: text(value.repositoryGrantId, 200, opaque),
    repositoryLinkedAt: integer(value.repositoryLinkedAt),
    baseRef: text(value.baseRef, 266, branchRef),
    baseCommitSha: text(value.baseCommitSha, 40, gitSha),
    baseTreeSha: text(value.baseTreeSha, 40, gitSha),
    adapter: parseBlumeDocsAdapter(value.adapter),
    files,
    omissions,
    validation,
  })
}

export function hostedDocsReview(input: unknown): HostedDocsReview {
  const bundle = parseHostedDocsReviewBundle(input)
  const approvalDigest = createHash('sha256').update(JSON.stringify(bundle)).digest('hex')
  return Object.freeze({ bundle, approvalDigest })
}
