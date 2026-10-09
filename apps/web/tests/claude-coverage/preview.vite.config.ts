import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: fileURLToPath(new URL('../../preview', import.meta.url)),
  cacheDir: fileURLToPath(new URL('../../../../outputs/claude-coverage/.vite-preview', import.meta.url)),
  resolve: { dedupe: ['react', 'react-dom'] },
  plugins: [react()],
  server: { host: '127.0.0.1', port: 4482, strictPort: true, hmr: false },
})
