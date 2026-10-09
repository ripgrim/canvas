import { expect, it } from 'vitest'
import { sanitizeStartShell } from '../scripts/sanitize-start-shell.mjs'

it('escapes Start inline stream NUL bytes before HTML parsing changes bootstrap identity', () => {
  const input = '<html><script>window.state="root\0"</script><script src="/app.js"></script></html>'
  expect(sanitizeStartShell(input)).toBe('<html><script>window.state="root\\u0000"</script><script src="/app.js"></script></html>')
  expect(sanitizeStartShell('<script>window.state="safe"</script>')).toBe('<script>window.state="safe"</script>')
  expect(sanitizeStartShell('<div>body\0</div>')).toBe('<div>body\0</div>')
})