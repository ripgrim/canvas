import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { sourceBindingPlugin } from '@canvas/preview-runtime/source-binding-plugin'
import react from '@vitejs/plugin-react'

export default defineConfig({ root: 'preview', cacheDir: '../node_modules/.vite-sample-preview', resolve: { dedupe: ['react', 'react-dom'] }, plugins: [sourceBindingPlugin(['Button', 'Card', 'Input', 'Label'].map(exportName => ({ exportName, componentId: 'sample-' + exportName.toLowerCase(), entryPath: fileURLToPath(new URL('../../tests/fixtures/component-repo-seed/src/atoms/' + exportName + '.tsx', import.meta.url)) })), fileURLToPath(new URL('../../packages/preview-runtime/dist/source-bindings.mjs', import.meta.url))), react()], server: { host: '127.0.0.1', port: 4318, strictPort: true }, build: { outDir: '../dist/sample-preview', emptyOutDir: true } })
