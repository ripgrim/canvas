import { readFile } from 'node:fs/promises'
import { build } from 'vite'
import { sourceBindingPlugin } from './source-binding-plugin.mjs'

try {
  const settings = JSON.parse(await readFile(process.argv[2], 'utf8'))
  await build({
    configFile: false,
    envFile: false,
    root: settings.workRoot,
    base: `/build/${settings.generation}/`,
    logLevel: 'silent',
    publicDir: false,
    plugins: [sourceBindingPlugin(settings.sourceBindings ?? [], settings.bindingRuntime)],
    resolve: { alias: Object.entries(settings.alias).map(([name, replacement]) => ({ find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), replacement })) },
    esbuild: { jsx: 'automatic' },
    build: { outDir: settings.outputRoot, emptyOutDir: true, sourcemap: false, minify: false, rollupOptions: { input: settings.htmlPath } },
  })
  process.stdout.write(JSON.stringify({ ok: true }))
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, message: error instanceof Error ? error.message.slice(0, 4000) : 'Preview build failed' }))
  process.exitCode = 1
}
