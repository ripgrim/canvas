import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'node22',
    outDir: 'dist/preload',
    emptyOutDir: true,
    lib: { entry: 'src/preload/index.ts', formats: ['cjs'], fileName: () => 'index.cjs' },
    rollupOptions: { external: ['electron'] },
    minify: false,
  },
})
