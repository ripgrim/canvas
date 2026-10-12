import type { AuthRequest, CollaborationRequest, RepositoryConnectionRequest, RepositoryRequest, UpdateRequest } from '../preload/contracts'
import type { EditorCollaborationInteraction, EditorCollaborationPatch, EditorCollaborationPoint, EditorCollaborationSelection, EditorCollaborationTransform, EditorPersistenceIntent } from '@canvas/editor/capabilities'
import { validateFileCommand } from '@canvas/repo-engine/file-document'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { parseGitHubCloneRequest } from '@canvas/repository'

const analyticsScriptOrigin = 'https://cdn.databuddy.cc'
const analyticsIngestOrigin = 'https://basket.databuddy.cc'

export { localDevelopmentUrl as editorDevelopmentUrl } from './web-target'

export const secureWebPreferences = Object.freeze({
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  safeDialogs: true,
})

export function contentSecurityPolicy(development: boolean, previewOrigin: string | readonly string[] | null = null, scriptHashes: readonly string[] = []): string {
  const requestedPreviewOrigins = previewOrigin === null ? [] : typeof previewOrigin === 'string' ? [previewOrigin] : [...previewOrigin]
  const previewOrigins = [...new Set(requestedPreviewOrigins.map(origin => {
    let url: URL
    try { url = new URL(origin) } catch { throw new Error('Invalid preview origin.') }
    const local = url.protocol === 'http:' && url.hostname === '127.0.0.1'
    if ((!local && url.protocol !== 'https:') || url.origin !== origin || url.username || url.password) throw new Error('Invalid preview origin.')
    return url.origin
  }))]
  if (previewOrigins.length > 2) throw new Error('Invalid preview origin.')
  if (scriptHashes.length > 128 || scriptHashes.some((hash) => !/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(hash))) throw new Error('Invalid inline script hash.')
  return [
    "default-src 'none'",
    `script-src 'self' ${analyticsScriptOrigin}${development ? " 'unsafe-inline'" : ''}${scriptHashes.map((hash) => ` 'sha256-${hash}'`).join('')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${analyticsIngestOrigin}${development ? ' ws://127.0.0.1:4317' : ''}`,
    `frame-src ${previewOrigins.length ? [...new Set(previewOrigins)].join(' ') : "'none'"}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

export function hostedContentSecurityPolicy(): string {
  return contentSecurityPolicy(false).replace("style-src 'self' 'unsafe-inline'", "style-src 'self'")
}

export function isTrustedSender(sender: { webContentsId: number; isMainFrame: boolean; url: string }, expectedId: number, editorUrl: string): boolean {
  // Routes change the path (for example /file/<id>) but never the origin. The editor URL always ends with "/", so a prefix
  // match binds trust to that origin for both http://127.0.0.1:4317/ and design-editor://app/ (whose URL.origin is "null" in Node).
  return sender.webContentsId === expectedId && sender.isMainFrame && editorUrl.endsWith('/') && (sender.url === editorUrl || sender.url.startsWith(editorUrl))
}

export function parseRepositoryRequest(value: unknown): RepositoryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid command.')
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).sort().join(',') !== 'args,method') throw new Error('Invalid command.')
  const { method, args } = candidate
  if (typeof method !== 'string' || !Array.isArray(args)) throw new Error('Invalid command.')
  if (method === 'saveFile') {
    if ((args.length !== 2 && args.length !== 3) || !Number.isSafeInteger(args[1]) || args[1] < 0 || args[1] >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid command.')
    const file = args[0]
    if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).sort().join(',') !== 'fileId,nodes,pages,relationships,revision,schemaVersion,theme') throw new Error('Invalid command.')
    const stack: { value: unknown; depth: number }[] = [{ value: file, depth: 0 }]
    const seen = new Set<object>()
    let count = 0
    let characters = 0
    while (stack.length) {
      const entry = stack.pop()!
      count += 1
      // Matches the file validator's envelope (5000 nodes with fills and tokens, 4 MB) so valid files are never refused at the IPC layer.
      if (count > 400_000 || entry.depth > 70) throw new Error('Invalid command.')
      if (typeof entry.value === 'string') characters += entry.value.length
      else if (typeof entry.value === 'number') { if (!Number.isFinite(entry.value)) throw new Error('Invalid command.') }
      else if (typeof entry.value === 'object' && entry.value !== null) {
        if (seen.has(entry.value) || (!Array.isArray(entry.value) && ![Object.prototype, null].includes(Object.getPrototypeOf(entry.value)))) throw new Error('Invalid command.')
        seen.add(entry.value)
        for (const [key, child] of Object.entries(entry.value)) {
          if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Invalid command.')
          characters += key.length
          stack.push({ value: child, depth: entry.depth + 1 })
        }
      } else if (typeof entry.value !== 'boolean') throw new Error('Invalid command.')
      if (characters > 4_000_000) throw new Error('Invalid command.')
    }
    let intent: EditorPersistenceIntent | undefined
    if (args.length === 3) {
      const candidateIntent = args[2]
      if (!candidateIntent || typeof candidateIntent !== 'object' || Array.isArray(candidateIntent) || Object.keys(candidateIntent).sort().join(',') !== 'commands,kind') throw new Error('Invalid command.')
      const record = candidateIntent as { kind?: unknown; commands?: unknown }
      if (record.kind !== 'commands' || !Array.isArray(record.commands) || record.commands.length > 256) throw new Error('Invalid command.')
      intent = { kind: 'commands', commands: record.commands.map(command => validateFileCommand(command)) }
    }
    return intent ? { method, args: [file as FileDocument, args[1] as number, intent] } : { method, args: [file as FileDocument, args[1] as number] }
  }
  if (args.length > 2 || args.some((arg) => typeof arg !== 'string' || arg.length > 128)) throw new Error('Invalid command.')
  if ((method === 'listFiles' || method === 'createFile' || method === 'inspectFixture' || method === 'refresh' || method === 'scanShadcn') && args.length === 0) return { method, args: [] }
  if (method === 'openFile' && args.length === 1 && /^[A-Za-z0-9_-]{1,80}$/.test(args[0])) return { method, args: [args[0]] }
  if (method === 'prepareLabelPadding' && args.length === 1 && /^(?:0|\d{1,3}(?:\.\d{1,2})?(?:px|rem))(?: (?:0|\d{1,3}(?:\.\d{1,2})?(?:px|rem))){0,3}$/.test(args[0])) return { method, args: [args[0]] }
  if (method === 'prepareToken' && args.length === 1 && /^#[\da-fA-F]{6}$/.test(args[0])) return { method, args: [args[0]] }
  if (method === 'preparePromotion' && args.length === 1 && /^[A-Z][A-Za-z0-9]{0,63}$/.test(args[0])) return { method, args: [args[0]] }
  if ((method === 'prepareUndo' || method === 'prepareRedo') && args.length === 1 && /^[A-Za-z0-9_-]{1,128}$/.test(args[0])) return { method, args: [args[0]] }
  if (method === 'savePrepared' && args.length === 2 && /^[A-Za-z0-9_-]{1,128}$/.test(args[0]) && /^[\da-f]{64}$/.test(args[1])) return { method, args: [args[0], args[1]] }
  throw new Error('Invalid command.')
}

const collaborationId = /^[A-Za-z0-9:._-]{1,128}$/
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',')
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const coordinate = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10_000_000
const identifier = (value: unknown): value is string => typeof value === 'string' && collaborationId.test(value)

function point(value: unknown): EditorCollaborationPoint {
  if (!record(value) || !exact(value, ['pageId', 'x', 'y']) || !identifier(value.pageId) || !coordinate(value.x) || !coordinate(value.y)) throw new Error('Invalid collaboration command.')
  return value as EditorCollaborationPoint
}

function selection(value: unknown): EditorCollaborationSelection {
  if (!record(value) || !exact(value, ['pageId', 'nodeIds']) || !identifier(value.pageId) || !Array.isArray(value.nodeIds) || value.nodeIds.length > 512 || value.nodeIds.some(nodeId => !identifier(nodeId))) throw new Error('Invalid collaboration command.')
  return { pageId: value.pageId, nodeIds: [...value.nodeIds] as string[] }
}

function transform(value: unknown): EditorCollaborationTransform {
  if (!record(value) || !identifier(value.nodeId) || !coordinate(value.dx) || !coordinate(value.dy) || !exact(value, ['nodeId', 'dx', 'dy', ...(Object.hasOwn(value, 'width') ? ['width'] : []), ...(Object.hasOwn(value, 'height') ? ['height'] : [])])) throw new Error('Invalid collaboration command.')
  if ((Object.hasOwn(value, 'width') && (!coordinate(value.width) || (value.width as number) < 0)) || (Object.hasOwn(value, 'height') && (!coordinate(value.height) || (value.height as number) < 0))) throw new Error('Invalid collaboration command.')
  return value as EditorCollaborationTransform
}

function interaction(value: unknown): EditorCollaborationInteraction {
  if (!record(value) || !exact(value, ['interactionId', 'pageId', 'kind', 'nodeIds', 'transforms']) || !identifier(value.interactionId) || !identifier(value.pageId) || (value.kind !== 'move' && value.kind !== 'resize') || !Array.isArray(value.nodeIds) || !value.nodeIds.length || value.nodeIds.length > 256 || value.nodeIds.some(nodeId => !identifier(nodeId)) || !Array.isArray(value.transforms) || value.transforms.length > 256) throw new Error('Invalid collaboration command.')
  return { interactionId: value.interactionId, pageId: value.pageId, kind: value.kind, nodeIds: [...value.nodeIds] as string[], transforms: value.transforms.map(transform) }
}

function collaborationPatch(value: unknown): EditorCollaborationPatch {
  if (!record(value)) throw new Error('Invalid collaboration command.')
  const allowed = new Set(['pageId', 'focused', 'selection', 'camera', 'cursor', 'interaction'])
  if (!Object.keys(value).length || Object.keys(value).some(key => !allowed.has(key))) throw new Error('Invalid collaboration command.')
  const patch: Record<string, unknown> = {}
  if (Object.hasOwn(value, 'pageId')) { if (value.pageId !== null && !identifier(value.pageId)) throw new Error('Invalid collaboration command.'); patch.pageId = value.pageId }
  if (Object.hasOwn(value, 'focused')) { if (typeof value.focused !== 'boolean') throw new Error('Invalid collaboration command.'); patch.focused = value.focused }
  if (Object.hasOwn(value, 'selection')) patch.selection = value.selection === null ? null : selection(value.selection)
  if (Object.hasOwn(value, 'cursor')) patch.cursor = value.cursor === null ? null : point(value.cursor)
  if (Object.hasOwn(value, 'camera')) {
    if (value.camera === null) patch.camera = null
    else {
      if (!record(value.camera) || !exact(value.camera, ['pageId', 'x', 'y', 'zoom']) || !coordinate(value.camera.zoom) || (value.camera.zoom as number) <= 0) throw new Error('Invalid collaboration command.')
      point({ pageId: value.camera.pageId, x: value.camera.x, y: value.camera.y })
      patch.camera = value.camera
    }
  }
  if (Object.hasOwn(value, 'interaction')) patch.interaction = value.interaction === null ? null : interaction(value.interaction)
  return patch as EditorCollaborationPatch
}

export function parseCollaborationRequest(value: unknown): CollaborationRequest {
  if (!record(value) || !exact(value, ['method', 'args']) || typeof value.method !== 'string' || !Array.isArray(value.args)) throw new Error('Invalid collaboration command.')
  if ((value.method === 'getSnapshot' || value.method === 'retry' || value.method === 'leave') && value.args.length === 0) return { method: value.method, args: [] }
  if (value.method !== 'updateAwareness' || value.args.length !== 2) throw new Error('Invalid collaboration command.')
  const options = value.args[1]
  if (options !== undefined && (!record(options) || !exact(options, ['immediate']) || typeof options.immediate !== 'boolean')) throw new Error('Invalid collaboration command.')
  return { method: 'updateAwareness', args: [collaborationPatch(value.args[0]), options as Readonly<{ immediate?: boolean }> | undefined] }
}

export function parseRepositoryConnectionRequest(value: unknown): RepositoryConnectionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid repository connection command.')
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).sort().join(',') !== 'args,method' || typeof candidate.method !== 'string' || !Array.isArray(candidate.args)) throw new Error('Invalid repository connection command.')
  if (['pickLocal', 'getCurrent', 'scanCurrent'].includes(candidate.method) && candidate.args.length === 0) {
    return { method: candidate.method as 'pickLocal' | 'getCurrent' | 'scanCurrent', args: [] }
  }
  if (candidate.method === 'cloneGitHub' && candidate.args.length === 1) return { method: 'cloneGitHub', args: [parseGitHubCloneRequest(candidate.args[0])] }
  throw new Error('Invalid repository connection command.')
}

export function parseAuthRequest(value: unknown): AuthRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid auth command.')
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).sort().join(',') !== 'args,method' || !Array.isArray(candidate.args) || candidate.args.length !== 0) throw new Error('Invalid auth command.')
  if (candidate.method === 'getSession' || candidate.method === 'signInWithGitHub' || candidate.method === 'signOut') return { method: candidate.method, args: [] }
  throw new Error('Invalid auth command.')
}

export function parseUpdateRequest(value: unknown): UpdateRequest {
  if (!record(value) || !exact(value, ['method', 'args']) || !Array.isArray(value.args) || value.args.length !== 0) throw new Error('Invalid update command.')
  if (value.method === 'getSnapshot' || value.method === 'check' || value.method === 'download' || value.method === 'install') return { method: value.method, args: [] }
  throw new Error('Invalid update command.')
}
