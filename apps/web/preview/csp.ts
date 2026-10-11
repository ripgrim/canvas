const editorFrameAncestors = [
  'design-editor://app',
  'http://127.0.0.1:4317',
  'http://localhost:4317',
  'https://canvas.ripgrim.com',
]

export const previewContentSecurityPolicy = [
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
  `frame-ancestors ${editorFrameAncestors.join(' ')}`,
].join('; ')

export const previewResponseHeaders = Object.freeze({
  'Content-Security-Policy': previewContentSecurityPolicy,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
})
