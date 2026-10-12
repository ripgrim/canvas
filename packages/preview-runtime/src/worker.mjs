import { readFile, realpath, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { sourceBindingPlugin } from './source-binding-plugin.mjs'
import { verifiedModuleBoundaryPlugin, verifiedRegistryPlugin } from './verified-registry-plugin.mjs'

try {
  const settings = JSON.parse(await readFile(process.argv[2], 'utf8'))
  const expectedFlowProtocolRoot = await realpath(fileURLToPath(new URL('../../sync-protocol/dist/', import.meta.url)))
  if (!Array.isArray(settings.runtimeDependencyRoots) || settings.runtimeDependencyRoots.length !== 1 || typeof settings.runtimeDependencyRoots[0] !== 'string') throw new Error('Preview runtime dependency roots are invalid')
  const flowProtocolRoot = await realpath(settings.runtimeDependencyRoots[0])
  if (flowProtocolRoot !== expectedFlowProtocolRoot || !(await stat(flowProtocolRoot)).isDirectory()) throw new Error('Preview runtime dependency root is not the canonical flow protocol runtime')
  await build({
    configFile: false,
    envFile: false,
    root: settings.workRoot,
    base: `/build/${settings.generation}/`,
    logLevel: 'silent',
    publicDir: false,
    plugins: [
      sourceBindingPlugin(settings.sourceBindings ?? [], settings.bindingRuntime),
      verifiedRegistryPlugin(settings.verifiedRegistry),
      verifiedModuleBoundaryPlugin(settings.verifiedRegistry, [settings.workRoot, settings.runtimeRoot, flowProtocolRoot]),
    ],
    resolve: { alias: Object.entries(settings.alias).map(([name, replacement]) => ({ find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), replacement })) },
    esbuild: { jsx: 'automatic' },
    build: { outDir: settings.outputRoot, emptyOutDir: true, sourcemap: false, minify: false, rollupOptions: { input: settings.htmlPath } },
  })
  process.stdout.write(JSON.stringify({ ok: true }))
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, message: error instanceof Error ? error.message.slice(0, 4000) : 'Preview build failed' }))
  process.exitCode = 1
}
