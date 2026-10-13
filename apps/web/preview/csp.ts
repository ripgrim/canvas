const editorFrameAncestors = [
  'design-editor://app',
  'http://127.0.0.1:4317',
  'http://localhost:4317',
  'https://canvas.ripgrim.com',
]

function validatedLoopbackOrigin(value: string) {
  const origin = new URL(value)
  const loopback = origin.hostname === '127.0.0.1' || origin.hostname === 'localhost'
  if (origin.protocol !== 'http:' || !loopback || origin.origin !== value) {
    throw new Error('The preview editor origin must be an HTTP loopback origin.')
  }
  return origin.origin
}

export function createPreviewContentSecurityPolicy(additionalEditorOrigin?: string) {
  const ancestors = additionalEditorOrigin
    ? [...editorFrameAncestors, validatedLoopbackOrigin(additionalEditorOrigin)]
    : editorFrameAncestors
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${ancestors.join(' ')}`,
  ].join('; ')
}

export function createPreviewResponseHeaders(additionalEditorOrigin?: string) {
  return Object.freeze({
    'Content-Security-Policy': createPreviewContentSecurityPolicy(additionalEditorOrigin),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  })
}

export const previewContentSecurityPolicy = createPreviewContentSecurityPolicy()

export const previewResponseHeaders = createPreviewResponseHeaders()
