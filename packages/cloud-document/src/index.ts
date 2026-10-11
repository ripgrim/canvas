import { validateFileDocument } from '@canvas/repo-engine/file-document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { upgradeFileDocument } from '@canvas/repo-engine/file-migration'
import type { Atom } from '@canvas/repo-engine'
import { validateImageAssetReference } from '@canvas/repo-engine/appearance'
import type { ImageAssetReference, ImageExtension, ImageMime } from '@canvas/repo-engine/appearance'

type ComponentShape = Readonly<{
  id: string
  componentId: string
  exportName: string
  props: Readonly<Record<string, unknown>>
  slots: readonly string[]
}>

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))

function componentShapes(value: unknown): ComponentShape[] {
  if (!record(value) || !record(value.nodes) || !record(value.relationships)) return []
  const slots = new Map<string, Set<string>>()
  for (const relationship of Object.values(value.relationships)) {
    if (!record(relationship) || typeof relationship.parentId !== 'string' || typeof relationship.slot !== 'string') continue
    const current = slots.get(relationship.parentId) ?? new Set<string>()
    current.add(relationship.slot)
    slots.set(relationship.parentId, current)
  }
  const shapes: ComponentShape[] = []
  for (const node of Object.values(value.nodes)) {
    if (!record(node) || node.type !== 'component' || typeof node.id !== 'string' || typeof node.componentId !== 'string' || typeof node.exportName !== 'string' || !record(node.props)) continue
    shapes.push({ id: node.id, componentId: node.componentId, exportName: node.exportName, props: node.props, slots: [...(slots.get(node.id) ?? [])] })
  }
  return shapes
}

function hostedAtoms(value: unknown): Atom[] {
  const groups = new Map<string, ComponentShape[]>()
  for (const shape of componentShapes(value)) {
    const current = groups.get(shape.componentId) ?? []
    current.push(shape)
    groups.set(shape.componentId, current)
  }
  return [...groups].map(([componentId, shapes]) => {
    const exports = new Set(shapes.map(shape => shape.exportName))
    if (exports.size !== 1) throw new Error('Component identity is inconsistent')
    const propTypes = new Map<string, Set<string>>()
    for (const shape of shapes) for (const [name, prop] of Object.entries(shape.props)) {
      const types = propTypes.get(name) ?? new Set<string>()
      types.add(typeof prop)
      propTypes.set(name, types)
    }
    for (const shape of shapes) for (const slot of shape.slots) {
      const types = propTypes.get(slot) ?? new Set<string>()
      types.add('ReactNode')
      propTypes.set(slot, types)
    }
    return {
      componentId,
      exportName: shapes[0]!.exportName,
      name: shapes[0]!.exportName,
      kind: 'atom',
      path: '',
      fingerprint: '',
      sourceHash: '',
      status: 'missing',
      candidates: [],
      props: [...propTypes].map(([name, types]) => ({ name, type: [...types].sort().join(' | '), optional: true })),
    }
  })
}

/**
 * Validates the complete hosted document graph while treating component source bindings as unavailable.
 * Source prop contracts are revalidated against a connected repository before code generation.
 */
export function validateHostedFileDocument(value: unknown): FileDocument {
  const upgraded = upgradeFileDocument(value)
  return validateFileDocument(upgraded, hostedAtoms(upgraded), { allowUnavailableBindings: true })
}

export type LegacyHostedImageAsset = Readonly<{
  id: string
  name: string
  mime: Exclude<ImageMime, 'image/avif'>
  extension: Exclude<ImageExtension, 'avif'>
  bytes: number
  width: number
  height: number
  data: string
}>

export type LegacyHostedAssetUpload = Readonly<{
  fileId: string
  asset: LegacyHostedImageAsset
}>

export type LegacyHostedAssetUploader = (input: LegacyHostedAssetUpload) => Promise<ImageAssetReference>

export type HostedDocumentExternalizationResult =
  | Readonly<{ status: 'current'; document: FileDocument }>
  | Readonly<{
      status: 'externalized'
      source: Readonly<Record<string, unknown>>
      document: FileDocument
      assets: readonly ImageAssetReference[]
    }>

const legacyImageMimes = new Set<LegacyHostedImageAsset['mime']>(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const legacyAssetByteLimit = 1_500_000
const legacyAssetDimensionLimit = 16_384
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/
const forbiddenIdentifiers = new Set(['__proto__', 'constructor', 'prototype'])
const legacyExtensionByMime: Readonly<Record<LegacyHostedImageAsset['mime'], LegacyHostedImageAsset['extension']>> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index])
}

function decodedBase64Length(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return value.length / 4 * 3 - padding
}

function legacyExtension(name: string, mime: LegacyHostedImageAsset['mime']): LegacyHostedImageAsset['extension'] {
  if (mime === 'image/jpeg' && /\.jpg$/i.test(name)) return 'jpg'
  return legacyExtensionByMime[mime]
}

function legacyAsset(value: unknown, key: string): LegacyHostedImageAsset {
  if (!record(value) || !exactKeys(value, ['id', 'name', 'mime', 'width', 'height', 'bytes', 'data'])) throw new Error('Invalid legacy image asset')
  if (value.id !== key || typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.id) || forbiddenIdentifiers.has(value.id)) throw new Error('Invalid legacy image asset identity')
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 256) throw new Error('Invalid legacy image asset name')
  if (typeof value.mime !== 'string' || !legacyImageMimes.has(value.mime as LegacyHostedImageAsset['mime'])) throw new Error('Unsupported legacy image type')
  if (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)
    || (value.width as number) < 1 || (value.height as number) < 1
    || (value.width as number) > legacyAssetDimensionLimit || (value.height as number) > legacyAssetDimensionLimit) {
    throw new Error('Invalid legacy image dimensions')
  }
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) < 1 || (value.bytes as number) > legacyAssetByteLimit) throw new Error('Invalid legacy image size')
  if (typeof value.data !== 'string' || value.data.length % 4 !== 0 || value.data.length > legacyAssetByteLimit * 4 / 3 + 4 || !base64Pattern.test(value.data)) throw new Error('Invalid legacy image data')
  if (decodedBase64Length(value.data) !== value.bytes) throw new Error('Legacy image size does not match its data')
  const mime = value.mime as LegacyHostedImageAsset['mime']
  return Object.freeze({
    id: value.id,
    name: value.name,
    mime,
    extension: legacyExtension(value.name, mime),
    bytes: value.bytes as number,
    width: value.width as number,
    height: value.height as number,
    data: value.data,
  })
}

function inlineLegacyAssets(value: unknown): Readonly<{ source: Readonly<Record<string, unknown>>; fileId: string; assets: readonly LegacyHostedImageAsset[] }> | null {
  if (!record(value) || value.schemaVersion !== 6 || !record(value.assets) || Object.keys(value.assets).length === 0) return null
  if (Object.keys(value.assets).length > 64) throw new Error('Design file exceeds the supported asset limit')
  if (typeof value.fileId !== 'string') throw new Error('Invalid design file identity')
  return Object.freeze({
    source: value,
    fileId: value.fileId,
    assets: Object.freeze(Object.entries(value.assets).map(([key, asset]) => legacyAsset(asset, key))),
  })
}

function referenceMatchesLegacy(reference: ImageAssetReference, asset: LegacyHostedImageAsset): boolean {
  return reference.id === asset.id
    && reference.name === asset.name
    && reference.mime === asset.mime
    && reference.extension === asset.extension
    && reference.bytes === asset.bytes
    && reference.width === asset.width
    && reference.height === asset.height
}

function versionSevenCandidate(source: Readonly<Record<string, unknown>>, assets: Readonly<Record<string, ImageAssetReference>>): Record<string, unknown> {
  return { ...source, schemaVersion: 7, assets }
}

/**
 * Externalizes the only hosted predecessor that carried image bytes. The complete graph is validated before any upload,
 * and only trusted upload results may replace the inline bytes.
 */
export async function externalizeHostedFileDocument(value: unknown, upload: LegacyHostedAssetUploader): Promise<HostedDocumentExternalizationResult> {
  const legacy = inlineLegacyAssets(value)
  if (!legacy) return Object.freeze({ status: 'current', document: validateHostedFileDocument(value) })

  const placeholders = Object.fromEntries(legacy.assets.map(asset => [asset.id, {
    id: asset.id,
    name: asset.name,
    mime: asset.mime,
    extension: asset.extension,
    bytes: asset.bytes,
    width: asset.width,
    height: asset.height,
    sha256: '0'.repeat(64),
  } satisfies ImageAssetReference]))
  validateHostedFileDocument(versionSevenCandidate(legacy.source, placeholders))

  const references: ImageAssetReference[] = []
  for (const asset of legacy.assets) {
    const reference = validateImageAssetReference(await upload({ fileId: legacy.fileId, asset }))
    if (!referenceMatchesLegacy(reference, asset)) throw new Error('Externalized image metadata does not match its source')
    references.push(Object.freeze({ ...reference }))
  }
  const assets = Object.fromEntries(references.map(reference => [reference.id, reference]))
  const document = validateHostedFileDocument(versionSevenCandidate(legacy.source, assets))
  return Object.freeze({ status: 'externalized', source: legacy.source, document, assets: Object.freeze(references) })
}
