import {
  HostedPreviewArtifactReconciliationError,
  parseHostedPreviewArtifactManifest,
  parseHostedPreviewArtifactFile,
  verifyHostedPreviewArtifactFiles,
} from "@canvas/preview-runtime/hosted-artifact"
import type {
  HostedPreviewArtifactFile,
  HostedPreviewArtifactManifest,
  HostedPreviewArtifactStageReceipt,
  HostedPreviewArtifactStorage,
} from "@canvas/preview-runtime/hosted-artifact"

import type {
  AssetDownload,
  AssetObjectInfo,
  AssetStore,
} from "./contracts.js"

type StoredState = Readonly<{
  version: 1
  artifactId: string
  stagingId: string
  status: "staged" | "published" | "discarded"
  manifest: HostedPreviewArtifactManifest
}>

type ReadState = Readonly<{
  value: StoredState
  etag: string
}>

export type PublishedHostedPreviewFile = Readonly<{
  manifest: HostedPreviewArtifactManifest
  file: HostedPreviewArtifactFile
  download: AssetDownload
}>

export type HostedPreviewArtifactAssetStorage = HostedPreviewArtifactStorage & Readonly<{
  uploadStagedFile(input: Readonly<{ artifactId: string; stagingId: string; file: HostedPreviewArtifactFile; bytes: Uint8Array }>): Promise<void>
  commitStagedArtifact(input: Readonly<{ artifactId: string; stagingId: string; manifest: HostedPreviewArtifactManifest }>): Promise<void>
  readPublishedFile(artifactId: string, path: string): Promise<PublishedHostedPreviewFile | null>
}>

export type HostedPreviewArtifactAssetStorageOptions = Readonly<{
  store: AssetStore
}>

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const stateByteLimit = 16 * 1024 * 1024

class HostedPreviewArtifactIdentityError extends Error {
  override readonly name = "HostedPreviewArtifactIdentityError"
}

export function createHostedPreviewArtifactAssetStorage(
  options: HostedPreviewArtifactAssetStorageOptions,
): HostedPreviewArtifactAssetStorage {
  const { store } = options

  async function readState(artifactId: string): Promise<ReadState | null> {
    requireUuid(artifactId)
    const stored = await store.download(stateKey(artifactId))
    if (!stored) return null
    if (!stored.info.etag) throw new Error("Hosted preview state has no version.")
    const bytes = await readBounded(stored.body, stateByteLimit)
    return { value: parseState(bytes, artifactId), etag: stored.info.etag }
  }

  async function writeState(
    value: StoredState,
    condition: Readonly<{ type: "create" } | { type: "match"; etag: string }>,
  ): Promise<AssetObjectInfo> {
    const body = new TextEncoder().encode(JSON.stringify(value))
    if (body.byteLength > stateByteLimit) throw new Error("Hosted preview state is too large.")
    return store.put(stateKey(value.artifactId), body, {
      contentType: "application/json; charset=utf-8",
      cacheControl: "private, no-store",
      metadata: {
        artifactId: value.artifactId,
        stagingId: value.stagingId,
        status: value.status,
      },
      condition,
    })
  }

  async function deleteFiles(state: StoredState): Promise<void> {
    const results = await Promise.allSettled(state.manifest.files.map(file =>
      store.delete(fileKey(state.artifactId, state.stagingId, file.path))))
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, "Hosted preview cleanup failed.")
  }

  async function validateStateFiles(state: StoredState): Promise<void> {
    for (const file of state.manifest.files) await readValidatedFile(store, state, file)
  }

  async function fenceFailedStage(state: StoredState, error: unknown): Promise<"reconciled"> {
    const discarded = freezeState({ ...state, status: "discarded" })
    try {
      await writeState(discarded, { type: "create" })
    } catch (fenceError) {
      let current: ReadState | null
      try { current = await readState(state.artifactId) }
      catch (statusError) {
        throw new HostedPreviewArtifactReconciliationError(
          [error, fenceError, statusError],
          "Hosted preview staging needs reconciliation.",
        )
      }
      if (!current) {
        throw new HostedPreviewArtifactReconciliationError(
          [error, fenceError],
          "Hosted preview staging needs reconciliation.",
        )
      }
      if (current.value.stagingId === state.stagingId && (current.value.status === "staged" || current.value.status === "published")) {
        if (!sameManifest(current.value.manifest, state.manifest)) {
          throw new HostedPreviewArtifactIdentityError("Hosted preview artifact identity already exists.")
        }
        await validateStateFiles(current.value)
        return "reconciled"
      }
      if (current.value.stagingId !== state.stagingId) {
        try { await deleteFiles(state) }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], "Hosted preview staging and cleanup failed.") }
        throw error
      }
    }
    try { await deleteFiles(discarded) }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Hosted preview staging and cleanup failed.") }
    throw error
  }

  const storage: HostedPreviewArtifactAssetStorage = {
    async uploadStagedFile(input) {
      const artifactId = requireUuid(input.artifactId)
      const stagingId = requireUuid(input.stagingId)
      const file = parseHostedPreviewArtifactFile(input.file)
      const bytes = new Uint8Array(input.bytes)
      if (bytes.byteLength !== file.bytes || await sha256(bytes) !== file.sha256) throw new Error("Hosted preview staged file is invalid.")
      const identity = { artifactId, stagingId }
      const existingState = await readState(artifactId)
      if (existingState && existingState.value.stagingId !== stagingId) throw new HostedPreviewArtifactIdentityError("Hosted preview artifact identity already exists.")
      const key = fileKey(artifactId, stagingId, file.path)
      try {
        await store.put(key, bytes, {
          contentType: file.contentType,
          cacheControl: "private, no-store",
          metadata: { artifactId, stagingId, path: file.path, sha256: file.sha256 },
          condition: { type: "create" },
        })
      } catch (error) {
        const existing = await store.download(key)
        if (!existing) throw error
        await validateDownloadedFile(existing, identity, file)
      }
    },

    async commitStagedArtifact(input) {
      const artifactId = requireUuid(input.artifactId)
      const stagingId = requireUuid(input.stagingId)
      const manifest = parseHostedPreviewArtifactManifest(input.manifest)
      const state = freezeState({ version: 1, artifactId, stagingId, status: "staged", manifest })
      const existing = await readState(artifactId)
      if (existing) {
        if (existing.value.stagingId === stagingId && sameManifest(existing.value.manifest, manifest) && (existing.value.status === "staged" || existing.value.status === "published")) {
          await validateStateFiles(existing.value)
          return
        }
        throw new HostedPreviewArtifactIdentityError("Hosted preview artifact identity already exists.")
      }
      await validateStateFiles(state)
      try { await writeState(state, { type: "create" }) }
      catch (error) {
        const resolved = await readState(artifactId)
        if (resolved?.value.stagingId === stagingId && sameManifest(resolved.value.manifest, manifest) && (resolved.value.status === "staged" || resolved.value.status === "published")) {
          await validateStateFiles(resolved.value)
          return
        }
        throw error
      }
    },

    async stage(input) {
      const artifactId = requireUuid(input.artifactId)
      const stagingId = requireUuid(input.stagingId)
      const manifest = parseHostedPreviewArtifactManifest(input.manifest)
      const files = new Map([...input.files].map(([path, bytes]) => [path, new Uint8Array(bytes)] as const))
      verifyHostedPreviewArtifactFiles(manifest, files)
      const state = freezeState({ version: 1, artifactId, stagingId, status: "staged", manifest })
      const existingState = await readState(artifactId)
      if (existingState) {
        if (existingState.value.stagingId === stagingId && sameManifest(existingState.value.manifest, manifest) && (existingState.value.status === "staged" || existingState.value.status === "published")) {
          await validateStateFiles(existingState.value)
          return
        }
        throw new HostedPreviewArtifactIdentityError("Hosted preview artifact identity already exists.")
      }
      const reconciliationErrors: unknown[] = []
      try {
        for (const file of manifest.files) {
          const key = fileKey(artifactId, stagingId, file.path)
          try {
            await store.put(key, files.get(file.path)!, {
              contentType: file.contentType,
              cacheControl: "private, no-store",
              metadata: { artifactId, stagingId, path: file.path, sha256: file.sha256 },
              condition: { type: "create" },
            })
          } catch (error) {
            let existingFile: AssetDownload | null
            try { existingFile = await store.download(key) }
            catch (statusError) { throw new HostedPreviewArtifactReconciliationError([error, statusError], "Hosted preview file staging needs reconciliation.") }
            if (!existingFile) throw error
            await validateDownloadedFile(existingFile, state, file)
            reconciliationErrors.push(error)
          }
        }
        try {
          await writeState(state, { type: "create" })
        } catch (error) {
          let current: ReadState | null
          try { current = await readState(artifactId) }
          catch (statusError) { throw new HostedPreviewArtifactReconciliationError([error, statusError], "Hosted preview staging needs reconciliation.") }
          if (current?.value.stagingId === stagingId && (current.value.status === "staged" || current.value.status === "published")) {
            if (!sameManifest(current.value.manifest, manifest)) {
              throw new HostedPreviewArtifactIdentityError("Hosted preview artifact identity already exists.")
            }
            await validateStateFiles(current.value)
            return
          }
          throw error
        }
      } catch (error) {
        if (error instanceof HostedPreviewArtifactReconciliationError) throw error
        if (error instanceof HostedPreviewArtifactIdentityError) {
          await fenceFailedStage(state, error)
          return
        }
        if (reconciliationErrors.length) {
          throw new HostedPreviewArtifactReconciliationError(
            [...reconciliationErrors, error],
            "Hosted preview file staging needs reconciliation.",
          )
        }
        await fenceFailedStage(state, error)
        return
      }
    },

    async publish(receipt) {
      requireReceipt(receipt)
      const current = await readState(receipt.artifactId)
      if (!current || current.value.stagingId !== receipt.stagingId || current.value.status === "discarded") {
        throw new Error("Hosted preview staging attempt is missing.")
      }
      if (current.value.status === "published") return
      const published = freezeState({ ...current.value, status: "published" })
      try {
        await writeState(published, { type: "match", etag: current.etag })
      } catch (error) {
        const resolved = await readState(receipt.artifactId)
        if (resolved?.value.stagingId === receipt.stagingId && resolved.value.status === "published") return
        throw error
      }
    },

    async status(receipt) {
      requireReceipt(receipt)
      const current = await readState(receipt.artifactId)
      if (!current || current.value.stagingId !== receipt.stagingId || current.value.status === "discarded") return "missing"
      return current.value.status
    },

    async discard(receipt) {
      requireReceipt(receipt)
      let current = await readState(receipt.artifactId)
      if (!current || current.value.stagingId !== receipt.stagingId || current.value.status === "published") return
      if (current.value.status === "staged") {
        const discarded = freezeState({ ...current.value, status: "discarded" })
        try {
          await writeState(discarded, { type: "match", etag: current.etag })
          current = await readState(receipt.artifactId)
        } catch (error) {
          const resolved = await readState(receipt.artifactId)
          if (resolved?.value.stagingId === receipt.stagingId && resolved.value.status === "published") return
          if (resolved?.value.stagingId !== receipt.stagingId || resolved.value.status !== "discarded") throw error
          current = resolved
        }
      }
      if (current?.value.stagingId === receipt.stagingId && current.value.status === "discarded") {
        await deleteFiles(current.value)
      }
    },

    async readPublishedFile(artifactId, path) {
      const current = await readState(requireUuid(artifactId))
      if (!current || current.value.status !== "published") return null
      const file = current.value.manifest.files.find(candidate => candidate.path === path)
      if (!file) return null
      const download = await readValidatedFile(store, current.value, file)
      return Object.freeze({ manifest: current.value.manifest, file, download })
    },
  }
  return storage
}

function freezeState(value: StoredState): StoredState {
  return Object.freeze({ ...value })
}

function parseState(bytes: Uint8Array, artifactId: string): StoredState {
  let value: unknown
  try { value = JSON.parse(new TextDecoder().decode(bytes)) }
  catch { throw new Error("Hosted preview state is invalid.") }
  if (!record(value) || Object.keys(value).sort().join(",") !== "artifactId,manifest,stagingId,status,version") {
    throw new Error("Hosted preview state is invalid.")
  }
  if (value.version !== 1 || value.artifactId !== artifactId || !uuidPattern.test(String(value.stagingId)) || !["staged", "published", "discarded"].includes(String(value.status))) {
    throw new Error("Hosted preview state is invalid.")
  }
  return freezeState({
    version: 1,
    artifactId,
    stagingId: String(value.stagingId),
    status: value.status as StoredState["status"],
    manifest: parseHostedPreviewArtifactManifest(value.manifest),
  })
}

function assertStoredFile(info: AssetObjectInfo, state: Readonly<{ artifactId: string; stagingId: string }>, file: HostedPreviewArtifactFile): void {
  const metadata = info.metadata
  if (info.size !== file.bytes || info.contentType !== file.contentType || metadata?.artifactId !== state.artifactId || metadata.stagingId !== state.stagingId || metadata.path !== file.path || metadata.sha256 !== file.sha256) {
    throw new Error("Published hosted preview file is invalid.")
  }
}

async function readValidatedFile(store: AssetStore, state: StoredState, file: HostedPreviewArtifactFile): Promise<AssetDownload> {
  const download = await store.download(fileKey(state.artifactId, state.stagingId, file.path))
  if (!download) throw new Error("Hosted preview staged file is missing.")
  return validateDownloadedFile(download, state, file)
}

async function validateDownloadedFile(download: AssetDownload, state: Readonly<{ artifactId: string; stagingId: string }>, file: HostedPreviewArtifactFile): Promise<AssetDownload> {
  assertStoredFile(download.info, state, file)
  const body = await readBounded(download.body, file.bytes)
  if (body.byteLength !== file.bytes || await sha256(body) !== file.sha256) {
    throw new Error("Hosted preview staged file is invalid.")
  }
  return {
    info: download.info,
    body: new ReadableStream({ start(controller) { controller.enqueue(body); controller.close() } }),
  }
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > limit) {
      await reader.cancel("Hosted preview state limit exceeded.")
      throw new Error("Hosted preview state is too large.")
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function requireReceipt(receipt: HostedPreviewArtifactStageReceipt): void {
  requireUuid(receipt.artifactId)
  requireUuid(receipt.stagingId)
}

function requireUuid(value: string): string {
  if (!uuidPattern.test(value)) throw new Error("Hosted preview identity is invalid.")
  return value
}

function stateKey(artifactId: string): string {
  return `hosted-previews/${artifactId}/state.json`
}

function fileKey(artifactId: string, stagingId: string, path: string): string {
  return `hosted-previews/${artifactId}/staging/${stagingId}/${path}`
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sameManifest(left: HostedPreviewArtifactManifest, right: HostedPreviewArtifactManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", buffer))
  return [...digest].map(value => value.toString(16).padStart(2, "0")).join("")
}
