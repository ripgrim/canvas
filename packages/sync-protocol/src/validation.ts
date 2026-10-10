import { syncProtocolVersion } from './types.js'
import type { ClientSyncMessage, FileEdit, JsonObject, JsonValue, PathSegment, ServerSyncMessage } from './types.js'

export const defaultMaxSyncMessageBytes = 256 * 1024

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])
const idPattern = /^[A-Za-z0-9:._-]{1,128}$/
const maxJsonDepth = 64
const maxJsonEntries = 20_000
const maxBatchEdits = 256
const maxPathSegments = 64

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isId = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value)
const isRevision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key))
}

function isJsonValue(input: unknown): input is JsonValue {
  let entries = 0
  const visit = (value: unknown, depth: number): value is JsonValue => {
    if (depth > maxJsonDepth || ++entries > maxJsonEntries) return false
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (Array.isArray(value)) return value.every(item => visit(item, depth + 1))
    if (!isRecord(value)) return false
    return Object.entries(value).every(([key, item]) => !forbiddenKeys.has(key) && visit(item, depth + 1))
  }
  return visit(input, 0)
}

function isJsonObject(input: unknown): input is JsonObject {
  return isRecord(input) && isJsonValue(input)
}

function isPathSegment(value: unknown): value is PathSegment {
  return typeof value === 'number'
    ? Number.isSafeInteger(value) && value >= 0
    : typeof value === 'string' && value.length > 0 && value.length <= 128 && !forbiddenKeys.has(value)
}

function isPath(value: unknown): value is readonly PathSegment[] {
  return Array.isArray(value) && value.length > 0 && value.length <= maxPathSegments && value.every(isPathSegment)
}

function isFileEdit(value: unknown): value is FileEdit {
  if (!isRecord(value) || !isPath(value.path)) return false
  if (value.type === 'set') return exactKeys(value, ['type', 'path', 'value']) && isJsonValue(value.value)
  if (value.type === 'delete') return exactKeys(value, ['type', 'path'])
  if (value.type === 'splice') {
    return exactKeys(value, ['type', 'path', 'index', 'deleteCount', 'values'])
      && Number.isSafeInteger(value.index) && (value.index as number) >= 0
      && Number.isSafeInteger(value.deleteCount) && (value.deleteCount as number) >= 0
      && Array.isArray(value.values) && value.values.length <= maxBatchEdits && value.values.every(isJsonValue)
  }
  return false
}

function parseObject(source: string | Uint8Array, maxBytes: number): Record<string, unknown> {
  if (source instanceof Uint8Array && source.byteLength > maxBytes) throw new Error('Sync message exceeds the byte limit')
  const text = typeof source === 'string' ? source : new TextDecoder('utf-8', { fatal: true }).decode(source)
  if (typeof source === 'string' && new TextEncoder().encode(text).byteLength > maxBytes) throw new Error('Sync message exceeds the byte limit')
  let input: unknown
  try { input = JSON.parse(text) } catch { throw new Error('Sync message is not valid JSON') }
  if (!isRecord(input)) throw new Error('Sync message must be an object')
  return input
}

export function parseClientSyncMessage(source: string | Uint8Array, maxBytes = defaultMaxSyncMessageBytes): ClientSyncMessage {
  const input = parseObject(source, maxBytes)
  if (input.protocolVersion !== syncProtocolVersion) throw new Error('Unsupported sync protocol version')
  if (input.type === 'file.subscribe') {
    if (!exactKeys(input, ['type', 'protocolVersion', 'requestId', 'fileId', 'clientId'], ['afterRevision']) || !isId(input.requestId) || !isId(input.fileId) || !isId(input.clientId) || (Object.hasOwn(input, 'afterRevision') && !isRevision(input.afterRevision))) throw new Error('Invalid file subscription')
    return input as FileSubscribeMessageShape
  }
  if (input.type === 'file.edit.batch') {
    if (!exactKeys(input, ['type', 'protocolVersion', 'fileId', 'clientId', 'clientMutationId', 'baseRevision', 'edits']) || !isId(input.fileId) || !isId(input.clientId) || !isId(input.clientMutationId) || !isRevision(input.baseRevision) || !Array.isArray(input.edits) || input.edits.length === 0 || input.edits.length > maxBatchEdits || !input.edits.every(isFileEdit)) throw new Error('Invalid file edit batch')
    return input as FileEditMessageShape
  }
  if (input.type === 'file.presence') {
    if (!exactKeys(input, ['type', 'protocolVersion', 'fileId', 'clientId', 'sequence', 'data']) || !isId(input.fileId) || !isId(input.clientId) || !isRevision(input.sequence) || !isJsonObject(input.data)) throw new Error('Invalid file presence')
    return input as FilePresenceMessageShape
  }
  throw new Error('Unknown sync message type')
}

type FileSubscribeMessageShape = Extract<ClientSyncMessage, { type: 'file.subscribe' }>
type FileEditMessageShape = Extract<ClientSyncMessage, { type: 'file.edit.batch' }>
type FilePresenceMessageShape = Extract<ClientSyncMessage, { type: 'file.presence' }>

export function encodeServerSyncMessage(message: ServerSyncMessage): string {
  return JSON.stringify(message)
}
