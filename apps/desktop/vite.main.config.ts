import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'node22',
    outDir: 'dist/main',
    emptyOutDir: true,
    lib: { entry: { index: 'src/main/index.ts', 'repo-worker': 'src/main/repo-worker.ts' }, formats: ['es'] },
    rollupOptions: { external: ['electron', '@canvas/repo-engine', '@canvas/preview-runtime', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)] },
    minify: false,
  },
})
