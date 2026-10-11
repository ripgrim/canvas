import { validateFileCommand } from '@canvas/repo-engine/file-document'
import {
  collaborationDocumentSchemaVersion,
  collaborationEnvelopeSchemaVersion,
  collaborationProtocolEpoch,
  maxCollaborationAvatarUrlBytes,
  maxCollaborationConnectionNonceLength,
  maxCollaborationDisplayNameLength,
  maxCollaborationIdentifierLength,
  maxPresenceParticipants,
  maxRoomTicketPayloadBytes,
} from './collaboration.js'
import type {
  CollaborationJsonObject,
  CollaborationJsonValue,
  CollaborationMode,
  ClientLifecycleState,
  CollaborationClientMessage,
  CollaborationServerMessage,
  LoadPhase,
  PresenceCamera,
  PresenceParticipant,
  PresencePatch,
  PresencePoint,
  PresenceInteraction,
  PresenceSelection,
  PresenceState,
  PersistedSemanticCommand,
  SemanticFileCommand,
  ServerRoomEnvelope,
  VerifiedRoomTicketClaims,
  VerifiedRoomRole,
} from './collaboration.js'

export const defaultMaxCollaborationMessageBytes = 256 * 1024
export const maxSnapshotChunkBytes = 160 * 1024
export const maxSnapshotBytes = 128 * 1024 * 1024
export const maxSnapshotChunks = Math.ceil(maxSnapshotBytes / maxSnapshotChunkBytes)
export const maxRetryAfterMs = 60_000

const identifierPattern = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${maxCollaborationIdentifierLength - 1}}$`)
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const durableSequencePattern = /^(?:0|[1-9][0-9]{0,18})$/
const fencePattern = /^[1-9][0-9]{0,18}$/
const connectionNoncePattern = new RegExp(`^[A-Za-z0-9_-]{16,${maxCollaborationConnectionNonceLength}}$`)
const digestPattern = /^[a-f0-9]{64}$/
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
export const maxPostgresSignedInt64 = 9_223_372_036_854_775_807n
const maxPendingMutations = 512
const maxPresenceIdentifiers = 512
const maxPresenceCoordinate = 1_000_000_000
const maxPresenceZoom = 10_000
const semanticCommandLimits = { maxBatchCommands: 512, maxDepth: 32, maxBytes: defaultMaxCollaborationMessageBytes } as const

export function normalizeCollaborationDisplayName(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim()
}

function isDisplayName(value: unknown): value is string {
  return typeof value === 'string'
    && value === normalizeCollaborationDisplayName(value)
    && Array.from(value).length > 0
    && Array.from(value).length <= maxCollaborationDisplayNameLength
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && !/\p{Cf}/u.test(value)
}

function isAvatarUrl(value: unknown): value is string | null {
  if (value === null) return true
  if (typeof value !== 'string' || value.length === 0 || new TextEncoder().encode(value).byteLength > maxCollaborationAvatarUrlBytes) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.hostname.length > 0 && parsed.username === '' && parsed.password === '' && parsed.href === value
  } catch {
    return false
  }
}

export function validateCollaborationIdentity(value: unknown): Readonly<{ displayName: string; avatarUrl: string | null }> {
  if (!isRecord(value) || !exactKeys(value, ['displayName', 'avatarUrl']) || !isDisplayName(value.displayName) || !isAvatarUrl(value.avatarUrl)) {
    throw new Error('Invalid collaboration identity')
  }
  return Object.freeze({ displayName: value.displayName, avatarUrl: value.avatarUrl })
}

const lifecycleTransitions: Readonly<Record<ClientLifecycleState, readonly ClientLifecycleState[]>> = {
  cold: ['opening'],
  opening: ['authorizing', 'closing'],
  authorizing: ['hydrating-local', 'admission-queued', 'access-revoked', 'incompatible-build', 'capacity-refused', 'closing'],
  'hydrating-local': ['admission-queued', 'offline-clean', 'offline-dirty', 'closing'],
  'admission-queued': ['streaming', 'capacity-refused', 'draining', 'offline-clean', 'offline-dirty', 'access-revoked', 'closing'],
  streaming: ['applying', 'draining', 'offline-clean', 'offline-dirty', 'access-revoked', 'incompatible-build', 'closing'],
  applying: ['live', 'read-only', 'replaying', 'offline-clean', 'offline-dirty', 'access-revoked', 'incompatible-build', 'closing'],
  live: ['read-only', 'offline-clean', 'offline-dirty', 'parked', 'access-revoked', 'draining', 'closing'],
  'read-only': ['offline-clean', 'parked', 'access-revoked', 'draining', 'closing'],
  'offline-clean': ['reconnecting', 'offline-dirty', 'parked', 'access-revoked', 'closing'],
  'offline-dirty': ['reconnecting', 'access-revoked', 'closing'],
  reconnecting: ['authorizing', 'offline-clean', 'offline-dirty', 'closing'],
  replaying: ['live', 'read-only', 'offline-dirty', 'access-revoked', 'draining', 'closing'],
  parked: ['reconnecting', 'closing', 'access-revoked'],
  'access-revoked': ['closing'],
  'incompatible-build': ['closing'],
  'capacity-refused': ['closing'],
  draining: ['reconnecting', 'offline-clean', 'offline-dirty', 'closing'],
  closing: ['closed'],
  closed: ['opening', 'cold'],
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isIdentifier = (value: unknown): value is string => typeof value === 'string' && identifierPattern.test(value)
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value)
const isMutationId = (value: unknown): value is string => isIdentifier(value) && value.length >= 8
const isEphemeralCounter = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const isDurableSequence = (value: unknown): value is string => typeof value === 'string' && durableSequencePattern.test(value) && BigInt(value) <= maxPostgresSignedInt64
const isPositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const isRetryDelay = (value: unknown): value is number => isPositiveInteger(value) && value <= maxRetryAfterMs
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key))
}

export function isSemanticFileCommand(value: unknown): value is SemanticFileCommand {
  try { validateFileCommand(value, semanticCommandLimits); return true } catch { return false }
}

export function validateSemanticFileCommand(value: unknown): SemanticFileCommand {
  try { return validateFileCommand(value, semanticCommandLimits) }
  catch { throw new Error('Invalid semantic file command') }
}

function canonicalJsonValue(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJsonValue(value[key])}`).join(',')}}`
  }
  throw new Error('Semantic command contains a non-canonical value')
}

function copyCanonicalValue(value: unknown): CollaborationJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) return value
  if (Array.isArray(value)) return Object.freeze(value.map(copyCanonicalValue))
  if (isRecord(value)) {
    const result: Record<string, CollaborationJsonValue> = {}
    for (const [key, item] of Object.entries(value)) result[key] = copyCanonicalValue(item)
    return Object.freeze(result)
  }
  throw new Error('Semantic command contains a non-canonical value')
}

export function encodeSemanticCommandForPersistence(value: unknown): PersistedSemanticCommand {
  const command = validateSemanticFileCommand(value)
  const operationPayload: Record<string, CollaborationJsonValue> = {}
  for (const [key, item] of Object.entries(command)) {
    if (key !== 'type') operationPayload[key] = copyCanonicalValue(item)
  }
  const frozenPayload: CollaborationJsonObject = Object.freeze(operationPayload)
  return Object.freeze({ operationType: command.type, operationPayload: frozenPayload })
}

export function decodeSemanticCommandFromPersistence(value: unknown): SemanticFileCommand {
  if (!isRecord(value) || !exactKeys(value, ['operationType', 'operationPayload']) || typeof value.operationType !== 'string' || !isRecord(value.operationPayload) || Object.hasOwn(value.operationPayload, 'type')) {
    throw new Error('Invalid persisted semantic command')
  }
  const command = validateSemanticFileCommand({ type: value.operationType, ...value.operationPayload })
  return validateSemanticFileCommand(copyCanonicalValue(command))
}

export async function semanticOperationContentDigest(value: unknown): Promise<string> {
  const content = canonicalJsonValue({
    protocolEpoch: collaborationProtocolEpoch,
    ...encodeSemanticCommandForPersistence(value),
  })
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function isPresenceCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= maxPresenceCoordinate
}

function isPresencePoint(value: unknown): value is PresencePoint {
  return isRecord(value)
    && exactKeys(value, ['pageId', 'x', 'y'])
    && isIdentifier(value.pageId)
    && isPresenceCoordinate(value.x)
    && isPresenceCoordinate(value.y)
}

function isPresenceCamera(value: unknown): value is PresenceCamera {
  return isRecord(value)
    && exactKeys(value, ['pageId', 'x', 'y', 'zoom'])
    && isIdentifier(value.pageId)
    && isPresenceCoordinate(value.x)
    && isPresenceCoordinate(value.y)
    && typeof value.zoom === 'number'
    && Number.isFinite(value.zoom)
    && value.zoom > 0
    && value.zoom <= maxPresenceZoom
}

function isPresenceSelection(value: unknown): value is PresenceSelection {
  return isRecord(value)
    && exactKeys(value, ['pageId', 'nodeIds'])
    && isIdentifier(value.pageId)
    && Array.isArray(value.nodeIds)
    && value.nodeIds.length <= maxPresenceIdentifiers
    && value.nodeIds.every(isIdentifier)
    && new Set(value.nodeIds).size === value.nodeIds.length
}

function isPresenceInteraction(value: unknown): value is PresenceInteraction {
  if (!isRecord(value)
    || !exactKeys(value, ['interactionId', 'pageId', 'kind', 'nodeIds', 'transforms'])
    || !isIdentifier(value.interactionId)
    || !isIdentifier(value.pageId)
    || (value.kind !== 'move' && value.kind !== 'resize')
    || !Array.isArray(value.nodeIds)
    || value.nodeIds.length === 0
    || value.nodeIds.length > maxPresenceIdentifiers
    || !value.nodeIds.every(isIdentifier)
    || new Set(value.nodeIds).size !== value.nodeIds.length
    || !Array.isArray(value.transforms)
    || value.transforms.length > maxPresenceIdentifiers) return false
  const locked = new Set(value.nodeIds)
  return value.transforms.every(transform => isRecord(transform)
    && exactKeys(transform, ['nodeId', 'dx', 'dy'], ['width', 'height'])
    && isIdentifier(transform.nodeId)
    && locked.has(transform.nodeId)
    && isPresenceCoordinate(transform.dx)
    && isPresenceCoordinate(transform.dy)
    && (!Object.hasOwn(transform, 'width') || typeof transform.width === 'number' && Number.isFinite(transform.width) && transform.width > 0 && transform.width <= maxPresenceCoordinate)
    && (!Object.hasOwn(transform, 'height') || typeof transform.height === 'number' && Number.isFinite(transform.height) && transform.height > 0 && transform.height <= maxPresenceCoordinate))
}

function presencePageIds(value: PresencePatch | PresenceState): readonly string[] {
  return [
    value.pageId,
    value.selection?.pageId,
    value.camera?.pageId,
    value.cursor?.pageId,
    value.interaction?.pageId,
  ].filter((pageId): pageId is string => typeof pageId === 'string')
}

function hasOnePresencePage(value: PresencePatch | PresenceState): boolean {
  return new Set(presencePageIds(value)).size <= 1
}

function isPresencePatch(value: unknown): value is PresencePatch {
  if (!isRecord(value) || !exactKeys(value, [], ['pageId', 'focused', 'selection', 'camera', 'cursor', 'interaction']) || Object.keys(value).length === 0) return false
  if (Object.hasOwn(value, 'pageId') && value.pageId !== null && !isIdentifier(value.pageId)) return false
  if (Object.hasOwn(value, 'focused') && typeof value.focused !== 'boolean') return false
  if (Object.hasOwn(value, 'selection') && value.selection !== null && !isPresenceSelection(value.selection)) return false
  if (Object.hasOwn(value, 'camera') && value.camera !== null && !isPresenceCamera(value.camera)) return false
  if (Object.hasOwn(value, 'cursor') && value.cursor !== null && !isPresencePoint(value.cursor)) return false
  if (Object.hasOwn(value, 'interaction') && value.interaction !== null && !isPresenceInteraction(value.interaction)) return false
  return hasOnePresencePage(value as PresencePatch)
}

function isPresenceState(value: unknown): value is PresenceState {
  if (!isRecord(value)
    || !exactKeys(value, ['pageId', 'focused', 'selection', 'camera', 'cursor'], ['interaction'])
    || (value.pageId !== null && !isIdentifier(value.pageId))
    || typeof value.focused !== 'boolean'
    || (value.selection !== null && !isPresenceSelection(value.selection))
    || (value.camera !== null && !isPresenceCamera(value.camera))
    || (value.cursor !== null && !isPresencePoint(value.cursor))
    || (value.interaction !== undefined && value.interaction !== null && !isPresenceInteraction(value.interaction))) return false
  const state = value as unknown as PresenceState
  return hasOnePresencePage(state) && (presencePageIds(state).length === 0 || state.pageId !== null)
}

function isPresenceParticipant(value: unknown): value is PresenceParticipant {
  return isRecord(value)
    && exactKeys(value, ['presenceId', 'subjectId', 'displayName', 'avatarUrl', 'clientId', 'role', 'sequence', 'data'])
    && isIdentifier(value.presenceId)
    && isIdentifier(value.subjectId)
    && isDisplayName(value.displayName)
    && isAvatarUrl(value.avatarUrl)
    && isIdentifier(value.clientId)
    && (value.role === 'owner' || value.role === 'viewer')
    && (value.sequence === null || isEphemeralCounter(value.sequence))
    && isPresenceState(value.data)
}

function base64DecodedByteLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

function isRoomIdentity(value: unknown): value is { fileId: string; generationId: string } {
  return isRecord(value) && exactKeys(value, ['fileId', 'generationId']) && isUuid(value.fileId) && isUuid(value.generationId)
}

function isFenceToken(value: unknown): value is string {
  return typeof value === 'string' && fencePattern.test(value) && BigInt(value) <= maxPostgresSignedInt64
}

function isServerEnvelope(value: unknown): value is ServerRoomEnvelope {
  return isRecord(value) && exactKeys(value, ['protocolEpoch', 'schemaVersion', 'room', 'fenceToken']) && value.protocolEpoch === collaborationProtocolEpoch && value.schemaVersion === collaborationEnvelopeSchemaVersion && isRoomIdentity(value.room) && isFenceToken(value.fenceToken)
}

function parseObject(source: string, maxBytes: number): Record<string, unknown> {
  if (typeof source !== 'string') throw new Error('Binary collaboration messages are not supported')
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid collaboration message byte limit')
  if (new TextEncoder().encode(source).byteLength > maxBytes) throw new Error('Collaboration message exceeds the byte limit')
  let input: unknown
  try { input = JSON.parse(source) } catch { throw new Error('Collaboration message is not valid JSON') }
  if (!isRecord(input)) throw new Error('Collaboration message must be an object')
  return input
}

function assertRootVersion(input: Record<string, unknown>): void {
  if (input.protocolEpoch !== collaborationProtocolEpoch) throw new Error('Unsupported collaboration protocol epoch')
  if (input.schemaVersion !== collaborationEnvelopeSchemaVersion) throw new Error('Unsupported collaboration envelope schema')
}

function assertEnvelopeVersion(input: Record<string, unknown>): void {
  if (!isRecord(input.envelope)) throw new Error('Invalid collaboration envelope')
  if (input.envelope.protocolEpoch !== collaborationProtocolEpoch) throw new Error('Unsupported collaboration protocol epoch')
  if (input.envelope.schemaVersion !== collaborationEnvelopeSchemaVersion) throw new Error('Unsupported collaboration envelope schema')
}

export function isValidClientLifecycleTransition(from: ClientLifecycleState, to: ClientLifecycleState): boolean {
  return lifecycleTransitions[from].includes(to)
}

export function isValidLoadPhaseTransition(from: LoadPhase, to: LoadPhase): boolean {
  return from === 'stream' && to === 'apply'
}

export function collaborationModeForRole(role: VerifiedRoomRole): CollaborationMode {
  if (role === 'owner') return 'editable'
  if (role === 'viewer') return 'read_only'
  throw new Error('Invalid verified room role')
}

export function validateVerifiedRoomTicketClaimsShape(value: unknown): VerifiedRoomTicketClaims {
  if (!isRecord(value)
    || !exactKeys(value, ['subjectId', 'displayName', 'avatarUrl', 'fileId', 'role', 'generationId', 'protocolEpoch', 'buildId', 'expiresAtUnixMs', 'accessEpoch', 'clientId', 'connectionNonce'])
    || !isIdentifier(value.subjectId)
    || !isDisplayName(value.displayName)
    || !isAvatarUrl(value.avatarUrl)
    || !isUuid(value.fileId)
    || (value.role !== 'owner' && value.role !== 'viewer')
    || !isUuid(value.generationId)
    || value.protocolEpoch !== collaborationProtocolEpoch
    || !isIdentifier(value.buildId)
    || !isPositiveInteger(value.expiresAtUnixMs)
    || !isDurableSequence(value.accessEpoch)
    || !isIdentifier(value.clientId)
    || typeof value.connectionNonce !== 'string'
    || !connectionNoncePattern.test(value.connectionNonce)
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > maxRoomTicketPayloadBytes) throw new Error('Invalid verified room ticket claims')
  return value as VerifiedRoomTicketClaims
}

export function parseCollaborationClientMessage(source: string, maxBytes = defaultMaxCollaborationMessageBytes): CollaborationClientMessage {
  const input = parseObject(source, maxBytes)
  if (input.type === 'room.open') {
    assertRootVersion(input)
    if (!exactKeys(input, ['type', 'protocolEpoch', 'schemaVersion', 'requestId', 'fileId', 'clientId', 'buildId'], ['cachedSnapshotId', 'afterSequence']) || !isIdentifier(input.requestId) || !isUuid(input.fileId) || !isIdentifier(input.clientId) || !isIdentifier(input.buildId) || (Object.hasOwn(input, 'cachedSnapshotId') && !isIdentifier(input.cachedSnapshotId)) || (Object.hasOwn(input, 'afterSequence') && !isDurableSequence(input.afterSequence))) throw new Error('Invalid room open message')
    return input as unknown as CollaborationClientMessage
  }

  if (input.type === 'room.resume') {
    if (!exactKeys(input, ['type', 'requestId', 'afterSequence', 'pendingMutationIds']) || !isIdentifier(input.requestId) || !isDurableSequence(input.afterSequence) || !Array.isArray(input.pendingMutationIds) || input.pendingMutationIds.length > maxPendingMutations || !input.pendingMutationIds.every(isMutationId) || new Set(input.pendingMutationIds).size !== input.pendingMutationIds.length) throw new Error('Invalid room resume message')
    return input as unknown as CollaborationClientMessage
  }
  if (input.type === 'operation.submit') {
    if (!exactKeys(input, ['type', 'operation']) || !isRecord(input.operation) || !exactKeys(input.operation, ['mutationId', 'baseSequence', 'command']) || !isMutationId(input.operation.mutationId) || !isDurableSequence(input.operation.baseSequence) || !isSemanticFileCommand(input.operation.command)) throw new Error('Invalid semantic operation message')
    return input as unknown as CollaborationClientMessage
  }
  if (input.type === 'presence.update') {
    if (!exactKeys(input, ['type', 'sequence', 'data']) || !isEphemeralCounter(input.sequence) || !isPresencePatch(input.data)) throw new Error('Invalid presence update message')
    return input as unknown as CollaborationClientMessage
  }
  if (input.type === 'room.leave') {
    if (!exactKeys(input, ['type'])) throw new Error('Invalid room leave message')
    return input as unknown as CollaborationClientMessage
  }
  throw new Error('Unknown collaboration message type')
}

function isPreAssignmentError(input: Record<string, unknown>): boolean {
  if (!exactKeys(input, ['type', 'protocolEpoch', 'schemaVersion', 'requestId', 'code', 'message', 'retry'], ['retryAfterMs']) || !isIdentifier(input.requestId) || typeof input.message !== 'string' || input.message.length === 0) return false
  const terminal = new Set(['invalid_message', 'unauthorized', 'forbidden', 'file_not_found', 'internal_error'])
  if (terminal.has(String(input.code))) return input.retry === 'none' && !Object.hasOwn(input, 'retryAfterMs')
  if (input.code === 'unsupported_epoch' || input.code === 'unsupported_schema' || input.code === 'incompatible_build') return input.retry === 'refresh' && !Object.hasOwn(input, 'retryAfterMs')
  return input.code === 'capacity_refused' && input.retry === 'retry' && isRetryDelay(input.retryAfterMs)
}

function isRoomError(input: Record<string, unknown>): boolean {
  if (!exactKeys(input, ['type', 'envelope', 'code', 'message', 'retry'], ['mutationId', 'retryAfterMs']) || !isServerEnvelope(input.envelope) || typeof input.message !== 'string' || input.message.length === 0 || (Object.hasOwn(input, 'mutationId') && !isMutationId(input.mutationId))) return false
  const terminal = new Set(['room_scope_mismatch', 'mutation_id_reused', 'invalid_operation', 'read_only', 'access_revoked', 'internal_error'])
  if (terminal.has(String(input.code))) return input.retry === 'none' && !Object.hasOwn(input, 'retryAfterMs')
  if (input.code === 'incompatible_build') return input.retry === 'refresh' && !Object.hasOwn(input, 'retryAfterMs')
  return (input.code === 'capacity_refused' || input.code === 'draining') && input.retry === 'reconnect' && isRetryDelay(input.retryAfterMs)
}

function isServerMessage(input: Record<string, unknown>): boolean {
  if (input.type === 'request.error') return input.protocolEpoch === collaborationProtocolEpoch && input.schemaVersion === collaborationEnvelopeSchemaVersion && isPreAssignmentError(input)
  if (input.type === 'admission.queued') return exactKeys(input, ['type', 'protocolEpoch', 'schemaVersion', 'requestId']) && input.protocolEpoch === collaborationProtocolEpoch && input.schemaVersion === collaborationEnvelopeSchemaVersion && isIdentifier(input.requestId)
  if (input.type === 'room.error') return isRoomError(input)
  if (!isServerEnvelope(input.envelope)) return false
  if (input.type === 'room.assigned') return exactKeys(input, ['type', 'envelope', 'requestId', 'role']) && isIdentifier(input.requestId) && (input.role === 'owner' || input.role === 'viewer')
  if (input.type === 'load.phase') return exactKeys(input, ['type', 'envelope', 'requestId', 'phase']) && isIdentifier(input.requestId) && (input.phase === 'stream' || input.phase === 'apply')
  if (input.type === 'snapshot.begin') {
    return exactKeys(input, ['type', 'envelope', 'requestId', 'snapshotId', 'documentSchemaVersion', 'baseSequence', 'compression', 'contentEncoding', 'storedByteLength', 'documentByteLength', 'objectDigest', 'documentDigest', 'chunkCount'])
      && isIdentifier(input.requestId) && isIdentifier(input.snapshotId)
      && input.documentSchemaVersion === collaborationDocumentSchemaVersion
      && isDurableSequence(input.baseSequence)
      && input.compression === 'none'
      && input.contentEncoding === 'utf-8'
      && isPositiveInteger(input.storedByteLength) && input.storedByteLength <= maxSnapshotBytes
      && isPositiveInteger(input.documentByteLength) && input.documentByteLength <= maxSnapshotBytes
      && input.documentByteLength === input.storedByteLength
      && typeof input.objectDigest === 'string' && digestPattern.test(input.objectDigest)
      && typeof input.documentDigest === 'string' && digestPattern.test(input.documentDigest)
      && input.objectDigest === input.documentDigest
      && isPositiveInteger(input.chunkCount) && input.chunkCount <= maxSnapshotChunks
      && input.chunkCount === Math.ceil(input.storedByteLength / maxSnapshotChunkBytes)
  }
  if (input.type === 'snapshot.chunk') return exactKeys(input, ['type', 'envelope', 'requestId', 'snapshotId', 'chunkIndex', 'chunkCount', 'data']) && isIdentifier(input.requestId) && isIdentifier(input.snapshotId) && isEphemeralCounter(input.chunkIndex) && isPositiveInteger(input.chunkCount) && input.chunkCount <= maxSnapshotChunks && input.chunkIndex < input.chunkCount && typeof input.data === 'string' && input.data.length > 0 && base64Pattern.test(input.data) && base64DecodedByteLength(input.data) <= maxSnapshotChunkBytes
  if (input.type === 'snapshot.end') return exactKeys(input, ['type', 'envelope', 'requestId', 'snapshotId']) && isIdentifier(input.requestId) && isIdentifier(input.snapshotId)
  if (input.type === 'sync.ready') return exactKeys(input, ['type', 'envelope', 'requestId', 'snapshotId', 'serverSequence', 'role']) && isIdentifier(input.requestId) && isIdentifier(input.snapshotId) && isDurableSequence(input.serverSequence) && (input.role === 'owner' || input.role === 'viewer')
  if (input.type === 'operation.ack') return exactKeys(input, ['type', 'envelope', 'mutationId', 'sequence', 'status']) && isMutationId(input.mutationId) && isDurableSequence(input.sequence) && (input.status === 'applied' || input.status === 'duplicate')
  if (input.type === 'operation.applied') return exactKeys(input, ['type', 'envelope', 'mutationId', 'sequence', 'subjectId', 'command']) && isMutationId(input.mutationId) && isDurableSequence(input.sequence) && isIdentifier(input.subjectId) && isSemanticFileCommand(input.command)
  if (input.type === 'presence.roster') return exactKeys(input, ['type', 'envelope', 'participants']) && Array.isArray(input.participants) && input.participants.length <= maxPresenceParticipants && input.participants.every(isPresenceParticipant) && new Set(input.participants.map(participant => participant.clientId)).size === input.participants.length && new Set(input.participants.map(participant => participant.presenceId)).size === input.participants.length
  if (input.type === 'presence.join' || input.type === 'presence.changed') return exactKeys(input, ['type', 'envelope', 'participant']) && isPresenceParticipant(input.participant)
  if (input.type === 'presence.leave') return exactKeys(input, ['type', 'envelope', 'presenceId', 'subjectId', 'clientId']) && isIdentifier(input.presenceId) && isIdentifier(input.subjectId) && isIdentifier(input.clientId)
  if (input.type === 'operation.rebase_required') return exactKeys(input, ['type', 'envelope', 'mutationId', 'baseSequence', 'authoritativeSequence', 'retry']) && isMutationId(input.mutationId) && isDurableSequence(input.baseSequence) && isDurableSequence(input.authoritativeSequence) && BigInt(input.authoritativeSequence) > BigInt(input.baseSequence) && input.retry === 'resync'
  return false
}

export function parseCollaborationServerMessage(source: string, maxBytes = defaultMaxCollaborationMessageBytes): CollaborationServerMessage {
  const input = parseObject(source, maxBytes)
  if (input.type === 'request.error' || input.type === 'admission.queued') assertRootVersion(input)
  else assertEnvelopeVersion(input)
  if (!isServerMessage(input)) throw new Error('Invalid collaboration server message')
  return input as unknown as CollaborationServerMessage
}

/** Rejects a valid but stale message from another room generation or authority. */
export function serverMessageMatchesEnvelope(message: CollaborationServerMessage, expected: ServerRoomEnvelope): boolean {
  if (message.type === 'request.error' || message.type === 'admission.queued') return false
  return message.envelope.room.fileId === expected.room.fileId && message.envelope.room.generationId === expected.room.generationId && message.envelope.fenceToken === expected.fenceToken
}

export function encodeCollaborationMessage(message: CollaborationClientMessage | CollaborationServerMessage): string {
  return JSON.stringify(message)
}
