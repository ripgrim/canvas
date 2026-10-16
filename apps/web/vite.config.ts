import { defineConfig, loadEnv } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

export default defineConfig(({ mode }) => {
  const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const version = JSON.parse(readFileSync(resolve(workspaceRoot, 'package.json'), 'utf8')).version as string
  const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? null
  const buildId = process.env.VERCEL_DEPLOYMENT_ID ?? process.env.GITHUB_RUN_ID ?? `${version}-${Date.now()}`
  const remoteDevHost = process.env.CANVAS_REMOTE_DEV_HOST?.trim()
  for (const [key, value] of Object.entries(loadEnv(mode, workspaceRoot, ''))) if (process.env[key] === undefined) process.env[key] = value
  return {
    envDir: workspaceRoot,
    cacheDir: 'node_modules/.vite-start',
    server: { host: '127.0.0.1', port: 4317, strictPort: true, allowedHosts: remoteDevHost ? [remoteDevHost] : [] },
    optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
    define: { __DESIGN_EDITOR_WEB_BUILD_ID__: JSON.stringify(buildId), __DESIGN_EDITOR_APP_VERSION__: JSON.stringify(version) },
    plugins: [{ name: 'canvas-version-manifest', generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ buildId, version, commit }) }) } }, tanstackStart({ spa: { enabled: true }, router: { routeTreeFileHeader: [] } }), react()],
  }
})
