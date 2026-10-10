import { defineConfig, loadEnv } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export default defineConfig(({ mode }) => {
  const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  for (const [key, value] of Object.entries(loadEnv(mode, workspaceRoot, ''))) if (process.env[key] === undefined) process.env[key] = value
  return {
    envDir: workspaceRoot,
    cacheDir: 'node_modules/.vite-start',
    server: { host: '127.0.0.1', port: 4317, strictPort: true },
    optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
    plugins: [tanstackStart({ spa: { enabled: true }, router: { routeTreeFileHeader: [] } }), react()],
  }
})
