import { createHash, randomUUID } from 'node:crypto'
import { link, open, realpath, rename, unlink } from 'node:fs/promises'
import { confined, metadataDirectory, readOptional } from './paths.js'
import { validateDocument } from './document.js'
import type { EditorDocument } from './document.js'
import { validateFileDocument } from './file-document.js'
import type { FileDocument, FileValidationOptions } from './file-document.js'
import { isFileDocumentShape, isLegacyDocument, migrateLegacyPages, upgradeFileDocument } from './file-migration.js'
import type { Atom } from './types.js'

const observations = new Map<string, { revision: number; hash: string | null }>()
const documentPath = '.design-editor/document.json'
/** The original version 1 bytes, copied once before the first save replaces them with a version 2 file. */
export const legacyBackupPath = '.design-editor/document.v1.backup.json'
// The validator bounds the compact file at 4 MB; the stored copy is pretty-printed, so the raw read limit is wider.
const sourceLimit = 8_000_000
const checksum = (source: string | null) => source === null ? null : createHash('sha256').update(source).digest('hex')

export type DocumentDiskState = {
  file: FileDocument | null
  hash: string | null
  /** True when the stored bytes are a version 1 document that was migrated in memory and not yet rewritten. */
  legacy: boolean
}
export const documentContentHash = (file: FileDocument): string => checksum(JSON.stringify(file, null, 2))!

/** Page identity used for a project's single migrated version 1 page, so repeated reads produce the same file. */
export const legacyPageId = (projectId: string) => `page-${projectId}`

/** Wraps one version 1 composition document as a version 2 file. The page keeps the v1 revision so saves stay monotonic. */
export function fileFromLegacyDocument(projectId: string, document: EditorDocument, atoms: Atom[], options: FileValidationOptions = {}): FileDocument {
  const { file } = migrateLegacyPages(projectId, [{ id: legacyPageId(projectId), name: document.frame.name ?? 'Page 1', document }], atoms, options)
  file.revision = document.revision
  return file
}

type StoredDocument = { kind: 'file'; file: FileDocument } | { kind: 'legacy'; document: EditorDocument }

function parseStored(source: string, atoms: Atom[], options: FileValidationOptions): StoredDocument {
  if (source.length > sourceLimit) throw new Error('Document exceeds the supported size')
  const parsed: unknown = JSON.parse(source)
  if (isFileDocumentShape(parsed)) return { kind: 'file', file: validateFileDocument(upgradeFileDocument(parsed), atoms, options) }
  if (isLegacyDocument(parsed)) return { kind: 'legacy', document: validateDocument(parsed, atoms, options) }
  throw new Error('Unsupported design file version')
}

/**
 * The stored kind, revision, and identity only. Saving replaces the stored bytes wholesale, so it checks the revision and
 * hash without re-validating bindings that a reviewed identity change (for example a renamed export) has just moved.
 */
function storedHeader(source: string): { kind: 'file' | 'legacy'; revision: number; fileId: string | null } {
  if (source.length > sourceLimit) throw new Error('Document exceeds the supported size')
  const parsed: unknown = JSON.parse(source)
  const revision = (parsed as { revision?: unknown } | null)?.revision
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw new Error('Invalid stored document revision')
  if (isFileDocumentShape(parsed)) return { kind: 'file', revision: revision as number, fileId: typeof parsed.fileId === 'string' ? parsed.fileId : null }
  if (isLegacyDocument(parsed)) return { kind: 'legacy', revision: revision as number, fileId: null }
  throw new Error('Unsupported design file version')
}

export async function readDocumentState(root: string, projectId: string, atoms: Atom[], options: FileValidationOptions = {}): Promise<DocumentDiskState> {
  const canonical = await realpath(root)
  const source = await readOptional(canonical, documentPath)
  const stored = source === null ? null : parseStored(source, atoms, options)
  const file = stored === null ? null : stored.kind === 'file' ? stored.file : fileFromLegacyDocument(projectId, stored.document, atoms, options)
  observations.set(canonical, { revision: file?.revision ?? 0, hash: checksum(source) })
  return { file, hash: checksum(source), legacy: stored?.kind === 'legacy' }
}

export async function loadFile(root: string, projectId: string, atoms: Atom[], options: FileValidationOptions = {}): Promise<FileDocument | null> {
  return (await readDocumentState(root, projectId, atoms, options)).file
}

/** Copies the version 1 bytes to the backup path unless a backup already exists. The link never replaces an existing file. */
async function backupLegacy(canonical: string, before: string) {
  const temporary = `.design-editor/document.v1.${randomUUID()}.tmp`
  const temporaryPath = await confined(canonical, temporary)
  const handle = await open(temporaryPath, 'wx')
  try {
    try { await handle.writeFile(before, 'utf8'); await handle.sync() } finally { await handle.close() }
    await link(temporaryPath, await confined(canonical, legacyBackupPath)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
  } finally {
    await unlink(temporaryPath)
  }
}

export async function saveDocument(root: string, input: FileDocument, expectedRevision: number, atoms: Atom[], expectedHash?: string | null): Promise<FileDocument> {
  const file = validateFileDocument(input, atoms)
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision === Number.MAX_SAFE_INTEGER) throw new Error('Invalid expected document revision')
  const canonical = await realpath(root)
  await metadataDirectory(canonical)
  const lockPath = await confined(canonical, '.design-editor/document.lock')
  const lock = await open(lockPath, 'wx').catch(() => { throw new Error('Another document save is running') })
  const temporary = `.design-editor/document.${randomUUID()}.tmp`
  let temporaryExists = false
  try {
    const before = await readOptional(canonical, documentPath)
    const current = before === null ? null : storedHeader(before)
    if ((current?.revision ?? 0) !== expectedRevision) throw new Error('Document conflict: the saved revision changed')
    if (current?.kind === 'file' && current.fileId !== file.fileId) throw new Error('Document conflict: a different design file is stored')
    const observed = observations.get(canonical)
    if (expectedHash !== undefined) {
      if (expectedHash !== checksum(before)) throw new Error('Document conflict: file contents changed after loading')
    } else {
      if (before !== null && !observed) throw new Error('Load the document before saving an existing revision')
      if (observed && (observed.revision !== expectedRevision || observed.hash !== checksum(before))) throw new Error('Document conflict: file contents changed after loading')
    }
    file.revision = expectedRevision + 1
    const source = JSON.stringify(file, null, 2)
    const handle = await open(await confined(canonical, temporary), 'wx')
    temporaryExists = true
    try { await handle.writeFile(source, 'utf8'); await handle.sync() } finally { await handle.close() }
    if (current?.kind === 'legacy' && before !== null) await backupLegacy(canonical, before)
    if (checksum(await readOptional(canonical, documentPath)) !== checksum(before)) throw new Error('Document conflict: file contents changed while saving')
    await rename(await confined(canonical, temporary), await confined(canonical, documentPath))
    temporaryExists = false
    observations.set(canonical, { revision: file.revision, hash: checksum(source) })
    return structuredClone(file)
  } finally {
    if (temporaryExists) await unlink(await confined(canonical, temporary))
    await lock.close()
    await unlink(lockPath)
  }
}
