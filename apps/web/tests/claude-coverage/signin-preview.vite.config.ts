import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { sourceBindingPlugin } from '@canvas/preview-runtime/source-binding-plugin'
import react from '@vitejs/plugin-react'

const atomPath = (exportName: string) => fileURLToPath(new URL(`../../../../tests/fixtures/component-repo-seed/src/atoms/${exportName}.tsx`, import.meta.url))

// Mirrors apps/web/vite.preview.config.ts so the bundled sample runs the live PreviewLogin app with source bindings.
export default defineConfig({
  root: fileURLToPath(new URL('../../preview', import.meta.url)),
  cacheDir: fileURLToPath(new URL('../../../../outputs/claude-coverage/.vite-signin-preview', import.meta.url)),
  resolve: { dedupe: ['react', 'react-dom'] },
  plugins: [
    sourceBindingPlugin(['Button', 'Card', 'Input', 'Label'].map(exportName => ({ exportName, componentId: `sample-${exportName.toLowerCase()}`, entryPath: atomPath(exportName) })), fileURLToPath(new URL('../../../../packages/preview-runtime/dist/source-bindings.mjs', import.meta.url))),
    react(),
  ],
  server: { host: '127.0.0.1', port: 4532, strictPort: true, hmr: false },
})
