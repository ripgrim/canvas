import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  cacheDir: 'node_modules/.vite-start',
  server: { host: '127.0.0.1', port: 4317, strictPort: true },
  optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
  plugins: [tanstackStart({ spa: { enabled: true }, router: { routeTreeFileHeader: [] } }), react()],
})
