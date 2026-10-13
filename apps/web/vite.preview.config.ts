import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { sourceBindingPlugin } from '@canvas/preview-runtime/source-binding-plugin'
import { loadVerifiedRegistryManifest } from '@canvas/preview-runtime/verified-registry'
import { verifiedModuleBoundaryPlugin, verifiedRegistryPlugin } from '@canvas/preview-runtime/verified-registry-plugin'
import { defineConfig } from 'vite'
import { createPreviewResponseHeaders } from './preview/csp'

const requireFromPreview = createRequire(import.meta.url)
const previewRoot = fileURLToPath(new URL('./preview/', import.meta.url))
const previewRuntimeRoot = fileURLToPath(new URL('../../packages/preview-runtime/dist/', import.meta.url))
const syncProtocolRoot = fileURLToPath(new URL('../../packages/sync-protocol/dist/', import.meta.url))
const viteRuntimeRoot = dirname(requireFromPreview.resolve('vite/package.json'))
const reactPluginPackage = resolve(dirname(requireFromPreview.resolve('@vitejs/plugin-react')), '../package.json')
const reactRefreshRuntimeRoot = dirname(createRequire(reactPluginPackage).resolve('react-refresh/package.json'))
const runtimeModule = fileURLToPath(new URL('../../packages/preview-runtime/dist/source-bindings.mjs', import.meta.url))
const manifestPath = process.env.CANVAS_VERIFIED_COMPONENT_REGISTRY?.trim()
if (!manifestPath) throw new Error('CANVAS_VERIFIED_COMPONENT_REGISTRY is required. Run the preview through pnpm dev:preview.')
const registry = await loadVerifiedRegistryManifest(manifestPath)
if (!registry) throw new Error('The verified component registry could not be loaded.')
const previewResponseHeaders = createPreviewResponseHeaders(process.env.CANVAS_PREVIEW_EDITOR_ORIGIN?.trim() || undefined)

export default defineConfig({
    root: 'preview',
    cacheDir: process.env.CANVAS_PREVIEW_CACHE_DIR?.trim() || 'preview/.vite-preview',
    resolve: { dedupe: ['react', 'react-dom'] },
    define: { __CANVAS_VERIFIED_REGISTRY_FINGERPRINT__: JSON.stringify(registry.fingerprint) },
    plugins: [
      sourceBindingPlugin(registry.components.map(component => ({ componentId: component.componentId, exportName: component.exportName, entryPath: component.absolutePath })), runtimeModule),
      verifiedRegistryPlugin(registry),
      verifiedModuleBoundaryPlugin(
        registry,
        [previewRoot, previewRuntimeRoot, syncProtocolRoot, viteRuntimeRoot, reactRefreshRuntimeRoot],
        ['/@vite/client', '/@react-refresh'],
      ),
      react(),
    ],
    // The isolated preview CSP intentionally blocks Vite's inline Fast Refresh preamble.
    // Keep HMR off so React modules are never transformed to depend on blocked globals.
    server: { host: '127.0.0.1', port: 4318, strictPort: true, hmr: false, headers: previewResponseHeaders },
    preview: { host: '127.0.0.1', port: 4318, strictPort: true, headers: previewResponseHeaders },
    build: { outDir: '../dist/preview', emptyOutDir: true },
})
