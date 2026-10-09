import { createBlankFile, validateFileDocument } from '@canvas/repo-engine/file-document'
import { upgradeFileDocument } from '@canvas/repo-engine/file-migration'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { Atom } from '@canvas/repo-engine/contracts'
import type { EditorFile } from '@canvas/editor/capabilities'
import { readLegacyFiles } from './migration'
import type { LegacyView } from './migration'

export { legacyBrowserFilesKey, migratedBrowserFileId } from './migration'
export type { LegacyView } from './migration'

/** File list only: names and timestamps. Listing never reads file contents. */
export const browserFilesIndexKey = 'design-editor.browser-files-index.v3'
/** One key per design file. */
export const browserFileKey = (fileId: string) => `design-editor.browser-file.${fileId}.v3`
export const browserFilesLockName = 'design-editor.browser-files.v3'

export type BrowserFileStorage = Pick<Storage, 'getItem' | 'setItem'>
export type BrowserFileLocks = { request<T>(name: string, callback: () => Promise<T>): Promise<T> }
export type BrowserOpenedFile = Readonly<{ name: string; file: FileDocument; legacyView?: LegacyView }>
type IndexEntry = { id: string; name: string; createdAt: number; updatedAt: number }
type FileIndex = { schemaVersion: 1; files: Record<string, IndexEntry> }
type ContentRecord = { schemaVersion: 1; file: FileDocument; legacyView?: LegacyView }
type Loaded = { index: FileIndex; pending: Map<string, string> | null }
type BrowserFileServiceOptions = Readonly<{
  storage: BrowserFileStorage
  locks?: BrowserFileLocks
  atoms: Atom[]
  /** Oldest single-draft key, migrated only when neither the index nor the version 2 collection exists. */
  legacyDraftKey: string
  now?: () => Date
  createId?: () => string
}>

const storageVersion = 1
const byteLimit = 4_000_000
const fileLimit = 100
const location = 'This browser'
const indexInvalid = 'The local file index is invalid. Its stored contents were left unchanged.'
const indexUnsupported = 'The local file index uses an unsupported format. Its stored contents were left unchanged.'
const fileInvalid = 'The local file is invalid. Its stored contents were left unchanged.'
const fileUnsupported = 'The local file uses an unsupported format. Its stored contents were left unchanged.'

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)
const validName = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 120
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const validThemeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value)
const byteSize = (value: string) => new TextEncoder().encode(value).byteLength
const emptyIndex = (): FileIndex => ({ schemaVersion: storageVersion, files: {} })

function fail(message: string, cause?: unknown): never { throw new Error(message, cause === undefined ? undefined : { cause }) }

function parseIndex(source: string): FileIndex {
  if (byteSize(source) > byteLimit) fail('The local file index exceeds the supported size. Its stored contents were left unchanged.')
  let value: unknown
  try { value = JSON.parse(source) } catch (error) { fail(indexInvalid, error) }
  if (!isObject(value)) fail(indexInvalid)
  if (value.schemaVersion !== storageVersion) fail(indexUnsupported)
  if (!exactKeys(value, ['schemaVersion', 'files']) || !isObject(value.files)) fail(indexInvalid)
  const entries = Object.entries(value.files)
  if (entries.length > fileLimit) fail(indexInvalid)
  const files: Record<string, IndexEntry> = {}
  for (const [key, entry] of entries) {
    if (!validId(key) || !isObject(entry) || !exactKeys(entry, ['id', 'name', 'createdAt', 'updatedAt']) || entry.id !== key || !validName(entry.name) || !validTime(entry.createdAt) || !validTime(entry.updatedAt)) fail(indexInvalid)
    files[key] = { id: key, name: entry.name, createdAt: entry.createdAt, updatedAt: entry.updatedAt }
  }
  return { schemaVersion: storageVersion, files }
}

function summary(entry: IndexEntry): EditorFile {
  // Zero means the legacy record never stored a time.
  return { id: entry.id, name: entry.name, location, ...(entry.updatedAt > 0 ? { updatedAt: new Date(entry.updatedAt).toISOString() } : {}) }
}

export function createBrowserFileService(options: BrowserFileServiceOptions) {
  const { storage, atoms } = options
  const now = options.now ?? (() => new Date())
  const createId = options.createId ?? (() => crypto.randomUUID())
  /** Serialized content seen at the last open or save, per file. A save refuses to replace anything else. */
  const observed = new Map<string, string>()

  const parseContent = (fileId: string, source: string): ContentRecord => {
    if (byteSize(source) > byteLimit) fail('The local file exceeds the supported size. Its stored contents were left unchanged.')
    let value: unknown
    try { value = JSON.parse(source) } catch (error) { fail(fileInvalid, error) }
    if (!isObject(value)) fail(fileInvalid)
    if (value.schemaVersion !== storageVersion) fail(fileUnsupported)
    if (!exactKeys(value, ['schemaVersion', 'file'], ['legacyView'])) fail(fileInvalid)
    let file: FileDocument
    // Older schema versions upgrade on read; the upgraded form is written back on the next save.
    try { file = validateFileDocument(upgradeFileDocument(value.file), atoms) } catch (error) { fail(fileInvalid, error) }
    if (file.fileId !== fileId) fail(fileInvalid)
    const view = value.legacyView
    let legacyView: LegacyView | undefined
    if (view !== undefined) {
      if (!isObject(view) || !exactKeys(view, ['activePageId'], ['previewTheme']) || !validId(view.activePageId) || (view.previewTheme !== undefined && !validThemeId(view.previewTheme))) fail(fileInvalid)
      const activePageId = view.activePageId as string; const previewTheme = view.previewTheme
      // A page deleted since migration leaves nothing to hand over.
      if (file.pages.some(page => page.id === activePageId)) legacyView = { activePageId, ...(typeof previewTheme === 'string' ? { previewTheme } : {}) }
    }
    return { schemaVersion: storageVersion, file, ...(legacyView ? { legacyView } : {}) }
  }

  const readIndex = (): FileIndex | null => {
    const source = storage.getItem(browserFilesIndexKey)
    return source === null ? null : parseIndex(source)
  }

  const write = (key: string, source: string) => {
    if (byteSize(source) > byteLimit) fail('The local file exceeds the supported size')
    try { storage.setItem(key, source) } catch (error) { fail('This browser could not store the local file. It may be out of space.', error) }
    if (storage.getItem(key) !== source) fail('The local file changed while saving')
  }

  /** Converts legacy data entirely in memory. Throws before anything is written when any record is invalid. */
  const planMigration = () => {
    const migrated = readLegacyFiles(storage, options.legacyDraftKey, atoms)
    if (!migrated) return null
    const index = emptyIndex()
    const contents = new Map<string, string>()
    for (const item of migrated) {
      const source = JSON.stringify({ schemaVersion: storageVersion, file: item.file, legacyView: item.legacyView } satisfies ContentRecord)
      if (byteSize(source) > byteLimit) fail(`The local file "${item.name}" exceeds the supported size after upgrading. Its stored contents were left unchanged.`)
      index.files[item.id] = { id: item.id, name: item.name, createdAt: item.createdAt, updatedAt: item.updatedAt }
      contents.set(item.id, source)
    }
    const indexSource = JSON.stringify(index)
    if (byteSize(indexSource) > byteLimit) fail('The local file index exceeds the supported size. Its stored contents were left unchanged.')
    return { index, indexSource, contents }
  }

  /** Must run while holding the lock. Legacy keys are only read and are never rewritten; the index is written last so it commits the migration. */
  const ensureIndexLocked = (): FileIndex => {
    const existing = readIndex()
    if (existing) return existing
    const plan = planMigration()
    if (!plan) return emptyIndex()
    for (const [fileId, source] of plan.contents) write(browserFileKey(fileId), source)
    write(browserFilesIndexKey, plan.indexSource)
    return plan.index
  }

  const withLock = async <T>(callback: () => Promise<T>): Promise<T> => {
    if (!options.locks) throw new Error('This browser cannot safely change local files.')
    return options.locks.request(browserFilesLockName, callback)
  }

  const load = async (): Promise<Loaded> => {
    const index = readIndex()
    if (index) return { index, pending: null }
    if (!options.locks) {
      // Without a lock nothing is written: legacy files stay readable from the converted copy in memory.
      const plan = planMigration()
      return plan ? { index: plan.index, pending: plan.contents } : { index: emptyIndex(), pending: null }
    }
    return { index: await withLock(async () => ensureIndexLocked()), pending: null }
  }

  const entryOf = (index: FileIndex, fileId: string) => Object.hasOwn(index.files, fileId) ? index.files[fileId]! : fail('The local file no longer exists')

  const readStoredContent = (fileId: string) => {
    const source = storage.getItem(browserFileKey(fileId))
    if (source === null) fail('The local file contents are missing. The file list was left unchanged.')
    return { source, record: parseContent(fileId, source) }
  }

  const opened = (entry: IndexEntry, record: ContentRecord): BrowserOpenedFile => structuredClone({ name: entry.name, file: record.file, ...(record.legacyView ? { legacyView: record.legacyView } : {}) })

  return {
    list: async (): Promise<readonly EditorFile[]> => {
      const { index } = await load()
      return Object.values(index.files).sort((left, right) => right.updatedAt - left.updatedAt).map(summary)
    },
    create: async (): Promise<EditorFile> => withLock(async () => {
      const index = ensureIndexLocked()
      const entries = Object.values(index.files)
      if (entries.length >= fileLimit) fail(`This browser supports up to ${fileLimit} local files.`)
      const fileId = createId(); const pageId = createId(); const rootNodeId = createId()
      if (!validId(fileId) || Object.hasOwn(index.files, fileId) || storage.getItem(browserFileKey(fileId)) !== null) fail('A unique local file ID could not be created')
      if (!validId(pageId) || !validId(rootNodeId) || new Set([fileId, pageId, rootNodeId]).size !== 3) fail('A unique local page ID could not be created')
      const used = new Set(entries.map(entry => entry.name)); let sequence = 1
      while (used.has(`Untitled ${sequence}`)) sequence += 1
      const timestamp = now().getTime()
      const entry: IndexEntry = { id: fileId, name: `Untitled ${sequence}`, createdAt: timestamp, updatedAt: timestamp }
      const file = validateFileDocument(createBlankFile(fileId, pageId, rootNodeId, 'Page 1'), atoms)
      const source = JSON.stringify({ schemaVersion: storageVersion, file } satisfies ContentRecord)
      write(browserFileKey(fileId), source)
      write(browserFilesIndexKey, JSON.stringify({ schemaVersion: storageVersion, files: { ...index.files, [fileId]: entry } } satisfies FileIndex))
      observed.set(fileId, source)
      return summary(entry)
    }),
    open: async (fileId: string): Promise<BrowserOpenedFile> => {
      if (!validId(fileId)) fail('The local file ID is invalid')
      const { index, pending } = await load()
      const entry = entryOf(index, fileId)
      const migrated = pending?.get(fileId)
      if (migrated !== undefined) return opened(entry, parseContent(fileId, migrated))
      const { source, record } = readStoredContent(fileId)
      observed.set(fileId, source)
      return opened(entry, record)
    },
    save: async (fileId: string, input: FileDocument, expectedRevision: number): Promise<BrowserOpenedFile> => {
      if (!validId(fileId)) fail('The local file ID is invalid')
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision === Number.MAX_SAFE_INTEGER) fail('Invalid expected document revision')
      return withLock(async () => {
        const file = validateFileDocument(input, atoms)
        if (file.fileId !== fileId) fail('The design file belongs to a different local file')
        const index = ensureIndexLocked()
        const entry = entryOf(index, fileId)
        const { source, record } = readStoredContent(fileId)
        if (record.file.revision !== expectedRevision) fail('Document conflict: the saved revision changed')
        const lastObserved = observed.get(fileId)
        if (lastObserved === undefined) fail('Open the local file before saving it')
        if (lastObserved !== source) fail('Document conflict: the stored file changed after loading')
        const saved: ContentRecord = { schemaVersion: storageVersion, file: { ...file, revision: expectedRevision + 1 }, ...(record.legacyView ? { legacyView: record.legacyView } : {}) }
        const savedSource = JSON.stringify(saved)
        write(browserFileKey(fileId), savedSource)
        observed.set(fileId, savedSource)
        const savedEntry = { ...entry, updatedAt: Math.max(entry.updatedAt, now().getTime()) }
        write(browserFilesIndexKey, JSON.stringify({ schemaVersion: storageVersion, files: { ...index.files, [fileId]: savedEntry } } satisfies FileIndex))
        return opened(savedEntry, saved)
      })
    },
  }
}
