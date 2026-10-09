import { validateDocument } from '@canvas/repo-engine/document'
import type { EditorDocument } from '@canvas/repo-engine/document'
import { migrateLegacyPages } from '@canvas/repo-engine/file-migration'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { Atom } from '@canvas/repo-engine/contracts'

/** Version 2 page collection written before the file index existed. Kept untouched as the recovery copy. */
export const legacyBrowserFilesKey = 'design-editor.browser-files.v1'
/** File id the single legacy draft was given when it became a file. */
export const migratedBrowserFileId = 'browser-local-sample'

/** View state the legacy collection stored per file. The editor owns view state now, so it is handed over, not kept in the file. */
export type LegacyView = Readonly<{ activePageId: string; previewTheme?: string }>
export type MigratedFile = Readonly<{ id: string; name: string; createdAt: number; updatedAt: number; file: FileDocument; legacyView: LegacyView }>
export type LegacyStorage = Pick<Storage, 'getItem'>

type LegacyPage = { id: string; name: string; document: EditorDocument }
type LegacyRecord = { id: string; name: string; createdAt?: string; updatedAt?: string; activePageId: string; previewTheme?: string; pages: LegacyPage[] }

const byteLimit = 4_000_000
const fileLimit = 100
const pageLimit = 100
const location = 'This browser'
const collectionInvalid = 'The local file collection is invalid. Its stored contents were left unchanged.'
const draftInvalid = 'The local draft is invalid. Its stored contents were left unchanged.'

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const legacyId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)
const themeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value)
const legacyDate = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
const legacyName = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 120
const byteSize = (value: string) => new TextEncoder().encode(value).byteLength
const pageName = (name: string | undefined) => (name ?? '').trim().slice(0, 128).trim() || 'Page 1'

function fail(message: string, cause?: unknown): never { throw new Error(message, cause === undefined ? undefined : { cause }) }

function parse(source: string, message: string): unknown {
  if (byteSize(source) > byteLimit) fail(message.replace('is invalid', 'exceeds the supported size'))
  try { return JSON.parse(source) as unknown } catch (error) { return fail(message, error) }
}

function readDocument(value: unknown, atoms: Atom[], message: string): EditorDocument {
  try { return validateDocument(value, atoms) } catch (error) { return fail(message, error) }
}

function readDraft(source: string, atoms: Atom[]): LegacyRecord[] {
  const document = readDocument(parse(source, draftInvalid), atoms, draftInvalid)
  const pageId = `page-${migratedBrowserFileId}`
  return [{ id: migratedBrowserFileId, name: 'Local draft', activePageId: pageId, pages: [{ id: pageId, name: pageName(document.frame.name), document }] }]
}

function readCollection(source: string, atoms: Atom[]): LegacyRecord[] {
  const value = parse(source, collectionInvalid)
  if (!isObject(value) || !Array.isArray(value.files) || value.files.length > fileLimit || (value.version !== 1 && value.version !== 2)) fail(collectionInvalid)
  const ids = new Set<string>()
  const claim = (id: unknown): id is string => { if (!legacyId(id) || ids.has(id)) return false; ids.add(id); return true }
  const dates = (item: Record<string, unknown>) => {
    if ((item.createdAt !== undefined && !legacyDate(item.createdAt)) || (item.updatedAt !== undefined && !legacyDate(item.updatedAt))) fail(collectionInvalid)
    return { ...(item.createdAt !== undefined ? { createdAt: item.createdAt as string } : {}), ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt as string } : {}) }
  }
  if (value.version === 1) {
    return value.files.map(item => {
      if (!isObject(item) || !claim(item.id) || !claim(`page-${item.id}`) || !legacyName(item.name) || item.location !== location) fail(collectionInvalid)
      const document = readDocument(item.document, atoms, collectionInvalid)
      const pageId = `page-${item.id}`
      return { id: item.id, name: item.name, ...dates(item), activePageId: pageId, pages: [{ id: pageId, name: pageName(document.frame.name), document }] }
    })
  }
  return value.files.map(item => {
    if (!isObject(item) || !claim(item.id) || !legacyId(item.projectId) || !legacyName(item.name) || item.location !== location || !legacyId(item.activePageId) || (item.previewTheme !== undefined && !themeId(item.previewTheme)) || !Array.isArray(item.pages) || item.pages.length === 0 || item.pages.length > pageLimit) fail(collectionInvalid)
    const pages = item.pages.map(page => {
      if (!isObject(page) || !claim(page.id) || !legacyName(page.name)) fail(collectionInvalid)
      return { id: page.id, name: pageName(page.name), document: readDocument(page.document, atoms, collectionInvalid) }
    })
    if (!pages.some(page => page.id === item.activePageId)) fail(collectionInvalid)
    return { id: item.id, name: item.name, ...dates(item), activePageId: item.activePageId, ...(item.previewTheme !== undefined ? { previewTheme: item.previewTheme as string } : {}), pages }
  })
}

function convert(record: LegacyRecord, atoms: Atom[]): MigratedFile {
  let file: FileDocument
  try { file = migrateLegacyPages(record.id, record.pages.map(page => ({ id: page.id, name: page.name, document: page.document })), atoms).file }
  catch (error) { return fail(`The local file "${record.name}" could not be upgraded. Its stored contents were left unchanged.`, error) }
  const createdAt = record.createdAt === undefined ? null : Math.max(0, Date.parse(record.createdAt))
  const updatedAt = record.updatedAt === undefined ? createdAt : Math.max(0, Date.parse(record.updatedAt))
  return {
    id: record.id, name: record.name, createdAt: createdAt ?? updatedAt ?? 0, updatedAt: updatedAt ?? 0, file,
    legacyView: { activePageId: record.activePageId, ...(record.previewTheme !== undefined ? { previewTheme: record.previewTheme } : {}) },
  }
}

/**
 * Reads and converts every legacy record without writing. Returns null when no legacy data exists. The version 2
 * collection wins over the older draft key because the collection already absorbed that draft when it was written.
 */
export function readLegacyFiles(storage: LegacyStorage, legacyDraftKey: string, atoms: Atom[]): MigratedFile[] | null {
  const collection = storage.getItem(legacyBrowserFilesKey)
  if (collection !== null) return readCollection(collection, atoms).map(record => convert(record, atoms))
  const draft = storage.getItem(legacyDraftKey)
  if (draft !== null) return readDraft(draft, atoms).map(record => convert(record, atoms))
  return null
}
