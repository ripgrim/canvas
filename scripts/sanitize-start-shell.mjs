import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function sanitizeStartShell(html) {
  return html.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (_match, open, body, close) => open + body.replaceAll('\0', '\\u0000') + close)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const path = resolve(root, 'apps/web/dist/client/_shell.html')
  const html = await readFile(path, 'utf8')
  await writeFile(path, sanitizeStartShell(html))
}