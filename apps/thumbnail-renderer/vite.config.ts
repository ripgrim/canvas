import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import react from '@vitejs/plugin-react'
import { sourceBindingPlugin } from '@canvas/preview-runtime/source-binding-plugin'
import { loadVerifiedRegistryManifest } from '@canvas/preview-runtime/verified-registry'
import { verifiedModuleBoundaryPlugin, verifiedRegistryPlugin } from '@canvas/preview-runtime/verified-registry-plugin'
import { defineConfig } from 'vite'

const appRoot = fileURLToPath(new URL('.', import.meta.url))
const requireFromRenderer = createRequire(import.meta.url)
const previewRuntimeRoot = fileURLToPath(new URL('../../packages/preview-runtime/dist/', import.meta.url))
const repoEngineRoot = fileURLToPath(new URL('../../packages/repo-engine/dist/', import.meta.url))
const viteRuntimeRoot = dirname(requireFromRenderer.resolve('vite/package.json'))
const requireFromReactPlugin = createRequire(requireFromRenderer.resolve('@vitejs/plugin-react'))
const reactRefreshRuntimeRoot = dirname(requireFromReactPlugin.resolve('react-refresh/package.json'))
const runtimeModule = fileURLToPath(new URL('../../packages/preview-runtime/dist/source-bindings.mjs', import.meta.url))
const manifestPath = process.env.CANVAS_VERIFIED_COMPONENT_REGISTRY?.trim()
if (!manifestPath) throw new Error('CANVAS_VERIFIED_COMPONENT_REGISTRY is required. Start the thumbnail renderer through the root development command.')
const registry = await loadVerifiedRegistryManifest(manifestPath)
if (!registry) throw new Error('The verified component registry could not be loaded.')

export default defineConfig({
    cacheDir: '.vite-thumbnail-renderer',
    resolve: { dedupe: ['react', 'react-dom'] },
    define: { __CANVAS_VERIFIED_REGISTRY_FINGERPRINT__: JSON.stringify(registry.fingerprint) },
    plugins: [
      sourceBindingPlugin(registry.components.map(component => ({ componentId: component.componentId, exportName: component.exportName, entryPath: component.absolutePath })), runtimeModule),
      verifiedRegistryPlugin(registry),
      verifiedModuleBoundaryPlugin(registry, [appRoot, previewRuntimeRoot, repoEngineRoot, viteRuntimeRoot, reactRefreshRuntimeRoot], ['/thumbnail-renderer', '/@vite/client', '/@react-refresh']),
      react(),
    ],
    server: { host: '127.0.0.1', port: 4323, strictPort: true },
})
