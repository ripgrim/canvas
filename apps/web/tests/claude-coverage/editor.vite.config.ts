import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'

const webRoot = fileURLToPath(new URL('../../', import.meta.url))

export default defineConfig({
  root: webRoot,
  cacheDir: fileURLToPath(new URL('../../../../outputs/claude-coverage/.vite-editor', import.meta.url)),
  server: { host: '127.0.0.1', port: 4481, strictPort: true, hmr: false },
  optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
  plugins: [tanstackStart({ spa: { enabled: true }, router: { routeTreeFileHeader: [] } }), react()],
})
