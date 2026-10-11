import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { sourceBindingPlugin } from '@canvas/preview-runtime/source-binding-plugin'
import { loadVerifiedRegistryManifest } from '@canvas/preview-runtime/verified-registry'
import { verifiedModuleBoundaryPlugin, verifiedRegistryPlugin } from '@canvas/preview-runtime/verified-registry-plugin'
import { defineConfig } from 'vite'

const requireFromPreview = createRequire(import.meta.url)
const previewRoot = fileURLToPath(new URL('./', import.meta.url))
const sharedPreviewRoot = fileURLToPath(new URL('../web/preview/', import.meta.url))
const previewRuntimeRoot = fileURLToPath(new URL('../../packages/preview-runtime/dist/', import.meta.url))
const viteRuntimeRoot = dirname(requireFromPreview.resolve('vite/package.json'))
const reactPluginPackage = resolve(dirname(requireFromPreview.resolve('@vitejs/plugin-react')), '../package.json')
const reactRefreshRuntimeRoot = dirname(createRequire(reactPluginPackage).resolve('react-refresh/package.json'))
const runtimeModule = fileURLToPath(new URL('../../packages/preview-runtime/dist/source-bindings.mjs', import.meta.url))
const manifestPath = process.env.CANVAS_VERIFIED_COMPONENT_REGISTRY?.trim()
if (!manifestPath) throw new Error('CANVAS_VERIFIED_COMPONENT_REGISTRY is required.')
const registry = await loadVerifiedRegistryManifest(manifestPath)
if (!registry) throw new Error('The verified component registry could not be loaded.')

export default defineConfig({
  root: '.',
  cacheDir: 'node_modules/.vite-preview',
  resolve: { dedupe: ['react', 'react-dom'] },
  define: { __CANVAS_VERIFIED_REGISTRY_FINGERPRINT__: JSON.stringify(registry.fingerprint) },
  plugins: [
    sourceBindingPlugin(registry.components.map(component => ({ componentId: component.componentId, exportName: component.exportName, entryPath: component.absolutePath })), runtimeModule),
    verifiedRegistryPlugin(registry),
    verifiedModuleBoundaryPlugin(registry, [previewRoot, sharedPreviewRoot, previewRuntimeRoot, viteRuntimeRoot, reactRefreshRuntimeRoot], ['/@vite/client', '/@react-refresh']),
    react(),
  ],
  build: { outDir: 'dist', emptyOutDir: true },
})
