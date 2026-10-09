import type { RepositoryRequest } from '../preload/contracts'
import type { FileDocument } from '@canvas/repo-engine/file-document'

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

export function contentSecurityPolicy(development: boolean, previewOrigin: string | null = null, scriptHashes: readonly string[] = []): string {
  if (previewOrigin !== null && !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(previewOrigin)) throw new Error('Invalid preview origin.')
  if (scriptHashes.length > 128 || scriptHashes.some((hash) => !/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(hash))) throw new Error('Invalid inline script hash.')
  return [
    "default-src 'none'",
    `script-src 'self'${development ? " 'unsafe-inline'" : ''}${scriptHashes.map((hash) => ` 'sha256-${hash}'`).join('')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${development ? ' ws://127.0.0.1:4317' : ''}`,
    `frame-src ${previewOrigin ?? "'none'"}`,
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
    if (args.length !== 2 || !Number.isSafeInteger(args[1]) || args[1] < 0 || args[1] >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid command.')
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
    return { method, args: [file as FileDocument, args[1]] }
  }
  if (args.length > 2 || args.some((arg) => typeof arg !== 'string' || arg.length > 128)) throw new Error('Invalid command.')
  if ((method === 'inspectFixture' || method === 'refresh') && args.length === 0) return { method, args: [] }
  if (method === 'prepareLabelPadding' && args.length === 1 && /^(?:0|\d{1,3}(?:\.\d{1,2})?(?:px|rem))(?: (?:0|\d{1,3}(?:\.\d{1,2})?(?:px|rem))){0,3}$/.test(args[0])) return { method, args: [args[0]] }
  if (method === 'prepareToken' && args.length === 1 && /^#[\da-fA-F]{6}$/.test(args[0])) return { method, args: [args[0]] }
  if (method === 'preparePromotion' && args.length === 1 && /^[A-Z][A-Za-z0-9]{0,63}$/.test(args[0])) return { method, args: [args[0]] }
  if ((method === 'prepareUndo' || method === 'prepareRedo') && args.length === 1 && /^[A-Za-z0-9_-]{1,128}$/.test(args[0])) return { method, args: [args[0]] }
  if (method === 'savePrepared' && args.length === 2 && /^[A-Za-z0-9_-]{1,128}$/.test(args[0]) && /^[\da-f]{64}$/.test(args[1])) return { method, args: [args[0], args[1]] }
  throw new Error('Invalid command.')
}
