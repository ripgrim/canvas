import { startPreview } from '@canvas/preview-runtime/browser'
import { RegistryEntry, RegistryProvider, registry, registryContract, registryProviderProps, registryThemeAdapters } from 'virtual:canvas-verified-component-registry'

export const bundledEditorOrigin = 'design-editor://app'

export function requireEditorOrigin(value: string | null, previewOrigin: string): string {
  if (!value || value === previewOrigin) throw new Error('A separate editor origin is required.')
  if (value === bundledEditorOrigin) return value

  let url: URL
  try { url = new URL(value) } catch { throw new Error('A separate editor origin is required.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) throw new Error('A separate editor origin is required.')
  return url.origin
}

const editorOrigin = requireEditorOrigin(new URLSearchParams(window.location.search).get('editorOrigin'), window.location.origin)
const compositionMode = new URLSearchParams(window.location.search).get('mode') === 'composition'
const Component = RegistryEntry ?? (() => null)
const sourceDocument = null

document.documentElement.dataset.previewRegistry = registryContract.fingerprint
document.documentElement.dataset.previewRegistryState = RegistryEntry ? 'verified' : 'unavailable'

startPreview({
  Component: compositionMode ? () => null : Component,
  Provider: RegistryProvider,
  providerProps: registryProviderProps,
  initialProps: {},
  generation: 1,
  editorOrigin,
  componentId: registryContract.entry?.componentId ?? 'unavailable-component-registry',
  registry,
  sourceDocument,
  themeAdapters: registryThemeAdapters,
})
