import type { FileEdit, JsonObject, PersistedFileEditBatch } from '@canvas/sync-protocol'
import type { CommitFileEditInput, CommitFileEditResult, SeedFile, SyncRepository } from './contracts.js'
import { applyFileEdits } from './json-edits.js'

type StoredFile = { document: JsonObject; revision: number; history: PersistedFileEditBatch[]; mutations: Map<string, PersistedFileEditBatch> }
type ApplyEdits = (document: JsonObject, edits: readonly FileEdit[]) => JsonObject

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}

const sameMutation = (batch: PersistedFileEditBatch, input: CommitFileEditInput): boolean => batch.clientId === input.clientId && batch.baseRevision === input.baseRevision && canonical(batch.edits) === canonical(input.edits)
const cloneBatch = (batch: PersistedFileEditBatch): PersistedFileEditBatch => structuredClone(batch)

export class InMemorySyncRepository implements SyncRepository {
  readonly #files = new Map<string, StoredFile>()
  readonly #queues = new Map<string, Promise<void>>()
  readonly #apply: ApplyEdits
  readonly #historyLimit: number

  constructor(files: readonly SeedFile[], options: Readonly<{ apply?: ApplyEdits; historyLimit?: number }> = {}) {
    this.#apply = options.apply ?? applyFileEdits
    this.#historyLimit = options.historyLimit ?? 1_000
    if (!Number.isSafeInteger(this.#historyLimit) || this.#historyLimit < 1) throw new Error('History limit must be a positive integer')
    for (const file of files) {
      if (this.#files.has(file.fileId)) throw new Error('File identities must be unique')
      this.#files.set(file.fileId, { document: structuredClone(file.document), revision: file.serverRevision ?? 0, history: [], mutations: new Map() })
    }
  }

  async load(fileId: string) {
    const file = this.#files.get(fileId)
    return file ? { fileId, serverRevision: file.revision, document: structuredClone(file.document) } : null
  }

  async changesSince(fileId: string, afterRevision: number) {
    const file = this.#files.get(fileId)
    return file ? this.#changes(file, afterRevision) : null
  }

  async open(fileId: string, afterRevision?: number) {
    return this.#exclusive(fileId, async () => {
      const file = this.#files.get(fileId)
      if (!file) return { status: 'not_found' } as const
      const payload = { fileId, serverRevision: file.revision, document: structuredClone(file.document) }
      if (afterRevision === undefined) return { status: 'payload', payload, reason: 'bootstrap' } as const
      if (afterRevision > file.revision) return { status: 'ahead', serverRevision: file.revision } as const
      if (afterRevision === file.revision) return { status: 'ready', fileId, serverRevision: file.revision } as const
      const batches = this.#changes(file, afterRevision)
      return batches
        ? { status: 'catchup', fileId, fromRevision: afterRevision, serverRevision: file.revision, batches } as const
        : { status: 'payload', payload, reason: 'history_unavailable' } as const
    })
  }

  async commit(input: CommitFileEditInput): Promise<CommitFileEditResult> {
    return this.#exclusive(input.fileId, async () => {
      const file = this.#files.get(input.fileId)
      if (!file) return { status: 'not_found' }
      const mutationKey = `${input.subjectId}:${input.clientMutationId}`
      const existing = file.mutations.get(mutationKey)
      if (existing) return sameMutation(existing, input) ? { status: 'duplicate', batch: cloneBatch(existing) } : { status: 'mutation_id_reused', serverRevision: file.revision }
      if (input.baseRevision !== file.revision) return { status: 'conflict', serverRevision: file.revision, batches: this.#changes(file, input.baseRevision) }
      let document: JsonObject
      try { document = this.#apply(file.document, input.edits) } catch { return { status: 'invalid_edit', serverRevision: file.revision } }
      const batch: PersistedFileEditBatch = {
        fileId: input.fileId,
        subjectId: input.subjectId,
        clientId: input.clientId,
        clientMutationId: input.clientMutationId,
        baseRevision: file.revision,
        serverRevision: file.revision + 1,
        edits: structuredClone(input.edits),
        committedAt: new Date().toISOString(),
      }
      file.document = document
      file.revision = batch.serverRevision
      file.history.push(batch)
      file.mutations.set(mutationKey, batch)
      if (file.history.length > this.#historyLimit) {
        const removed = file.history.splice(0, file.history.length - this.#historyLimit)
        for (const expired of removed) {
          const expiredKey = `${expired.subjectId}:${expired.clientMutationId}`
          if (file.mutations.get(expiredKey) === expired) file.mutations.delete(expiredKey)
        }
      }
      return { status: 'applied', batch: cloneBatch(batch) }
    })
  }

  #changes(file: StoredFile, afterRevision: number): readonly PersistedFileEditBatch[] | null {
    if (afterRevision === file.revision) return []
    const first = file.history[0]
    if (!first || afterRevision < first.baseRevision || afterRevision > file.revision) return null
    const result = file.history.filter(batch => batch.serverRevision > afterRevision)
    let expected = afterRevision
    for (const batch of result) { if (batch.baseRevision !== expected || batch.serverRevision !== expected + 1) return null; expected = batch.serverRevision }
    return expected === file.revision ? result.map(cloneBatch) : null
  }

  async #exclusive<T>(fileId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(fileId) ?? Promise.resolve()
    let release: () => void = () => {}
    const current = new Promise<void>(resolve => { release = resolve })
    const queued = previous.then(() => current)
    this.#queues.set(fileId, queued)
    await previous
    try { return await operation() } finally { release(); if (this.#queues.get(fileId) === queued) this.#queues.delete(fileId) }
  }
}
