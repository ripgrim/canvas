import { validateFileDocument } from '@canvas/repo-engine/file-document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import type { Atom } from './types'

/** Persisted undo history for one file. Entries restore the whole file plus the page and selection the user saw. */
export type HistoryEntry = { file: FileDocument; pageId: string; selection: string[] }
export type DocumentHistory = { past: HistoryEntry[]; future: HistoryEntry[] }
export type HistoryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export const documentHistoryLimit = 20
export const documentHistoryByteLimit = 2 * 1024 * 1024

const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const size = (source: string) => new TextEncoder().encode(source).byteLength
const exactFields = (value: Record<string, unknown>, fields: string[]) => Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key))

/** Version 2 keys: version 1 entries held per-page documents and are not readable as file history. */
function keyFor(fileId: string): string {
  if (typeof fileId !== 'string' || fileId.length === 0 || fileId.length > 256 || /[\u0000-\u001f\u007f]/.test(fileId)) throw new Error('Invalid history file identity')
  return `design-editor:document-history:v2:${encodeURIComponent(fileId)}`
}

function assertSerializable(value: unknown, active = new Set<object>(), depth = 0): void {
  if (depth > 80) throw new Error('Document history exceeds the nesting limit')
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return
  if ((!Array.isArray(value) && !plain(value)) || active.has(value as object)) throw new Error('Document history contains unsupported values')
  active.add(value as object)
  for (const [key, child] of Object.entries(value as object)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Document history contains an invalid property')
    assertSerializable(child, active, depth + 1)
  }
  active.delete(value as object)
}

function validateEntry(value: unknown, atoms: Atom[]): HistoryEntry {
  if (!plain(value) || !exactFields(value, ['file', 'pageId', 'selection'])) throw new Error('Invalid document history entry')
  const file = validateFileDocument(value.file, atoms, { allowUnavailableBindings: true })
  if (typeof value.pageId !== 'string' || !file.pages.some(page => page.id === value.pageId)) throw new Error('Document history names a missing page')
  const selection = value.selection
  if (!Array.isArray(selection) || selection.length > 500 || selection.some(id => typeof id !== 'string' || !Object.hasOwn(file.nodes, id) || file.nodes[id]!.type === 'root') || new Set(selection).size !== selection.length) throw new Error('Document history contains an invalid selection')
  return { file, pageId: value.pageId, selection: [...selection] as string[] }
}

function trim(history: DocumentHistory): DocumentHistory {
  if (!plain(history) || !exactFields(history, ['past', 'future']) || !Array.isArray(history.past) || !Array.isArray(history.future)) throw new Error('Invalid document history')
  const future = history.future.slice(-documentHistoryLimit)
  const remaining = documentHistoryLimit - future.length
  return { past: remaining ? history.past.slice(-remaining) : [], future }
}

function discardOldest(history: DocumentHistory) {
  if (history.past.length) history.past.shift()
  else history.future.shift()
}

export function saveDocumentHistory(storage: HistoryStorage, fileId: string, currentFile: FileDocument, history: DocumentHistory): void {
  const key = keyFor(fileId)
  const retained = trim(history)
  assertSerializable(currentFile)
  assertSerializable(retained)
  for (const entry of [...retained.past, ...retained.future]) {
    if (!plain(entry) || !exactFields(entry, ['file', 'pageId', 'selection'])) throw new Error('Invalid document history entry')
  }
  const encode = () => JSON.stringify({ version: 2, fileId, currentFile, history: retained })
  let source = encode()
  while (size(source) > documentHistoryByteLimit && (retained.past.length || retained.future.length)) {
    discardOldest(retained)
    source = encode()
  }
  if (size(source) > documentHistoryByteLimit) {
    storage.removeItem(key)
    throw new Error('The current file is too large to cache undo history')
  }
  storage.setItem(key, source)
}

/** Restores cached history only when the cached current file equals the reopened file; stale or malformed caches are dropped. */
export function loadDocumentHistory(storage: HistoryStorage, fileId: string, currentFile: FileDocument, atoms: Atom[]): DocumentHistory | null {
  const key = keyFor(fileId)
  const source = storage.getItem(key)
  if (source === null) return null
  let history: DocumentHistory | null = null
  try {
    if (size(source) > documentHistoryByteLimit) throw new Error('Document history exceeds its storage budget')
    const payload: unknown = JSON.parse(source)
    assertSerializable(payload)
    if (!plain(payload) || !exactFields(payload, ['version', 'fileId', 'currentFile', 'history']) || payload.version !== 2 || payload.fileId !== fileId) throw new Error('Unsupported document history')
    const current = validateFileDocument(payload.currentFile, atoms, { allowUnavailableBindings: true })
    if (JSON.stringify(current) !== JSON.stringify(currentFile)) throw new Error('Document history is stale')
    const candidate = payload.history
    if (!plain(candidate) || !exactFields(candidate, ['past', 'future']) || !Array.isArray(candidate.past) || !Array.isArray(candidate.future) || candidate.past.length + candidate.future.length > documentHistoryLimit) throw new Error('Invalid document history entries')
    history = { past: candidate.past.map(entry => validateEntry(entry, atoms)), future: candidate.future.map(entry => validateEntry(entry, atoms)) }
  } catch {
    storage.removeItem(key)
    return null
  }
  return history
}
