import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'
import { desktopUpdateChannel } from './src/main/package-environment'

const packageMode = process.env.DESIGN_EDITOR_PACKAGE_MODE
const packageEnvironment = packageMode === 'local' || packageMode === 'staging' || packageMode === 'production'
  ? {
      mode: packageMode,
      authURL: process.env.DESIGN_EDITOR_AUTH_URL ?? '',
      loginURL: process.env.DESIGN_EDITOR_LOGIN_URL ?? '',
      previewURL: process.env.DESIGN_EDITOR_PREVIEW_URL ?? '',
      assetsURL: process.env.DESIGN_EDITOR_ASSETS_URL ?? '',
      appURL: process.env.VITE_APP_URL ?? '',
      syncURL: process.env.VITE_SYNC_ORIGIN ?? '',
      collaborationBuildId: process.env.VITE_COLLABORATION_BUILD_ID ?? '',
      updateURL: process.env.DESIGN_EDITOR_UPDATE_URL ?? '',
      updateChannel: desktopUpdateChannel(packageMode, process.env.DESIGN_EDITOR_UPDATABLE === '1'),
    }
  : undefined

export default defineConfig({
  define: { __DESIGN_EDITOR_PACKAGE_ENVIRONMENT__: packageEnvironment === undefined ? 'undefined' : JSON.stringify(packageEnvironment) },
  build: {
    target: 'node22',
    outDir: 'dist/main',
    emptyOutDir: true,
    lib: { entry: { index: 'src/main/index.ts', 'repo-worker': 'src/main/repo-worker.ts', 'scan-worker': 'src/main/scan-worker.ts' }, formats: ['es'] },
    rollupOptions: { external: ['electron', 'electron-updater', '@canvas/auth', '@canvas/auth/electron', '@canvas/editor/updates', '@canvas/repo-engine', '@canvas/preview-runtime', '@canvas/preview-runtime/verified-registry', '@canvas/scanner', '@canvas/scanner/shadcn', '@canvas/scanner/preview-registry', '@canvas/repository', '@canvas/repository/node', '@canvas/sync-client', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)] },
    minify: false,
  },
})
