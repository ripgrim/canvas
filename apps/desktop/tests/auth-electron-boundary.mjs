import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { builtinModules } from 'node:module'
import electron from 'electron'
import { build } from 'vite'

const desktopRoot = resolve(import.meta.dirname, '..')
const sourceRoot = join(import.meta.dirname, 'electron-auth-boundary')
const output = await mkdtemp(join(tmpdir(), 'design-editor-auth-boundary-'))
const externals = ['electron', ...builtinModules, ...builtinModules.map(name => `node:${name}`)]

async function bundleMain() {
  await build({
    configFile: false,
    root: desktopRoot,
    logLevel: 'error',
    resolve: { alias: { '@canvas/auth': resolve(desktopRoot, '../../packages/auth/src/index.ts') } },
    build: {
      target: 'node22',
      outDir: output,
      emptyOutDir: true,
      lib: { entry: join(sourceRoot, 'main.ts'), formats: ['es'], fileName: () => 'main.mjs' },
      rollupOptions: { external: externals },
      minify: false,
    },
  })
}

async function bundleActualPreload() {
  await build({
    configFile: false,
    root: desktopRoot,
    logLevel: 'error',
    build: {
      target: 'node22',
      outDir: output,
      emptyOutDir: false,
      lib: { entry: resolve(desktopRoot, 'src/preload/index.ts'), formats: ['cjs'], fileName: () => 'preload.cjs' },
      rollupOptions: { external: ['electron'] },
      minify: false,
    },
  })
}

function launchElectron() {
  return new Promise((resolveLaunch, reject) => {
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    const child = spawn(electron, [output], { cwd: output, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`Electron auth boundary timed out.\n${stdout}\n${stderr}`))
    }, 30_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('exit', code => {
      clearTimeout(timeout)
      const evidence = stdout.split(/\r?\n/).find(line => line.startsWith('AUTH_ELECTRON_BOUNDARY_EVIDENCE '))
      if (code !== 0 || !evidence) reject(new Error(`Electron auth boundary failed with exit ${code}.\n${stdout}\n${stderr}`))
      else {
        process.stdout.write(`${evidence}\n`)
        resolveLaunch(undefined)
      }
    })
  })
}

try {
  await bundleMain()
  await bundleActualPreload()
  await Promise.all([
    copyFile(join(sourceRoot, 'renderer.html'), join(output, 'renderer.html')),
    copyFile(join(sourceRoot, 'renderer.js'), join(output, 'renderer.js')),
    writeFile(join(output, 'package.json'), JSON.stringify({ type: 'module', main: 'main.mjs' })),
  ])
  await launchElectron()
} finally {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(output, { recursive: true, force: true })
      break
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EBUSY' || attempt === 19) throw error
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    }
  }
}
