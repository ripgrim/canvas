export const allowedHostedEditorOrigins: readonly string[] = Object.freeze([])
export const bundledEditorOrigin = 'design-editor://app'
export const bundledEditorUrl = 'design-editor://app/'
export const localDevelopmentUrl = 'http://127.0.0.1:4317/'

export type EditorTarget =
  | { kind: 'local'; url: string; origin: string; development: boolean; localCapabilities: true }
  | { kind: 'hosted'; url: string; origin: string; development: false; localCapabilities: false }

export function resolveEditorTarget(webUrl: string | undefined, development: boolean, allowedOrigins: readonly string[] = allowedHostedEditorOrigins): EditorTarget {
  if (webUrl === undefined) return development
    ? { kind: 'local', url: localDevelopmentUrl, origin: 'http://127.0.0.1:4317', development: true, localCapabilities: true }
    : { kind: 'local', url: bundledEditorUrl, origin: bundledEditorOrigin, development: false, localCapabilities: true }
  if (!webUrl || webUrl.length > 2048 || webUrl.includes('#')) throw new Error('The hosted editor URL must be a canonical HTTPS URL without a fragment.')
  let url: URL
  try { url = new URL(webUrl) } catch { throw new Error('The hosted editor URL is invalid.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href !== webUrl) throw new Error('The hosted editor URL must be a canonical HTTPS URL without credentials or a fragment.')
  for (const origin of allowedOrigins) {
    let allowed: URL
    try { allowed = new URL(origin) } catch { throw new Error('The hosted editor origin allowlist is invalid.') }
    if (allowed.protocol !== 'https:' || allowed.origin !== origin) throw new Error('The hosted editor origin allowlist is invalid.')
  }
  if (!allowedOrigins.includes(url.origin)) throw new Error('The hosted editor origin is not allowed.')
  return { kind: 'hosted', url: url.href, origin: url.origin, development: false, localCapabilities: false }
}

export function localCapabilityArguments(target: EditorTarget, allowUnauthenticatedWorkspace = false): string[] {
  if (!target.localCapabilities) return []
  return ['--design-editor-local-capabilities', `--design-editor-editor-url=${target.url}`, ...(allowUnauthenticatedWorkspace ? ['--design-editor-unauthenticated-workspace'] : [])]
}

export function mayExposeLocalCapabilities(isMainFrame: boolean, argv: readonly string[], currentUrl: string): boolean {
  if (!isMainFrame || argv.filter((argument) => argument === '--design-editor-local-capabilities').length !== 1) return false
  const grants = argv.filter((argument) => argument.startsWith('--design-editor-editor-url='))
  if (grants.length !== 1) return false
  const authorizedUrl = grants[0]!.slice('--design-editor-editor-url='.length)
  if (authorizedUrl !== bundledEditorUrl && authorizedUrl !== localDevelopmentUrl) return false
  // The shell loads nested routes (for example /file/<id>) from the same origin after refresh or restart.
  return currentUrl === authorizedUrl || currentUrl.startsWith(authorizedUrl)
}
