import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnvironment } from 'dotenv'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
loadEnvironment({ path: resolve(root, '.env'), quiet: true })
loadEnvironment({ path: resolve(root, '.env.local'), quiet: true, override: true })
const children = new Set()
let stopping = false
const launch = (command, args, cwd) => {
  const child = spawn(command, args, { cwd, windowsHide: true, stdio: 'inherit' })
  children.add(child)
  child.once('exit', code => { children.delete(child); if (!stopping && code !== 0) stop(code ?? 1) })
  child.once('error', error => { process.stderr.write(`${error.message}\n`); stop(1) })
  return child
}
const stop = code => { if (stopping) return; stopping = true; for (const child of children) child.kill(); process.exitCode = code }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0))
const pnpm = process.env.npm_execpath
if (!pnpm) throw new Error('Run this command through pnpm dev.')
process.stdout.write('Building the shared web app and local source services.\n')
const build = launch(process.execPath, [pnpm, '-r', 'build'], root)
const code = await new Promise(resolveExit => build.once('exit', resolveExit))
if (code !== 0 || stopping) process.exit(code ?? 1)
const web = resolve(root, 'apps/web')
const webRequire = createRequire(resolve(web, 'package.json'))
const vite = resolve(dirname(webRequire.resolve('vite/package.json')), 'bin/vite.js')
launch(process.execPath, [vite, '--host', '127.0.0.1', '--port', '4317', '--strictPort'], web)
launch(process.execPath, [vite, '--config', 'vite.preview.config.ts', '--host', '127.0.0.1', '--port', '4318', '--strictPort'], web)
for (let attempt = 0; attempt < 100; attempt += 1) {
  if (stopping) process.exit(1)
  try { if ((await fetch('http://127.0.0.1:4317/')).ok && (await fetch('http://127.0.0.1:4318/')).ok) break } catch {}
  if (attempt === 99) { stop(1); throw new Error('The web app or isolated sample preview did not become ready.') }
  await new Promise(resolveWait => setTimeout(resolveWait, 200))
}
process.stdout.write('Web editor: http://127.0.0.1:4317/\nOpening the thin Electron host.\n')
const desktop = resolve(root, 'apps/desktop')
const desktopRequire = createRequire(resolve(desktop, 'package.json'))
const electron = launch(desktopRequire('electron'), [desktop, '--development'], desktop)
electron.once('exit', code => stop(code ?? 0))
