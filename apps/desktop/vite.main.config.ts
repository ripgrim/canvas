import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'node22',
    outDir: 'dist/main',
    emptyOutDir: true,
    lib: { entry: { index: 'src/main/index.ts', 'repo-worker': 'src/main/repo-worker.ts', 'scan-worker': 'src/main/scan-worker.ts' }, formats: ['es'] },
    rollupOptions: { external: ['electron', '@canvas/auth', '@canvas/auth/electron', '@canvas/repo-engine', '@canvas/preview-runtime', '@canvas/scanner', '@canvas/scanner/shadcn', '@canvas/repository', '@canvas/repository/node', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)] },
    minify: false,
  },
})
