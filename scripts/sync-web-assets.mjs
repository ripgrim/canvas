import { cp, copyFile, mkdir, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const source = resolve(root, 'apps/web/dist/client')
const destination = resolve(root, 'apps/desktop/dist/renderer')
const parent = await realpath(dirname(destination)).catch(() => dirname(destination))
const target = await realpath(destination).catch(() => resolve(parent, 'renderer'))
const location = relative(root, target)
if (!location || location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location) || target !== destination) throw new Error('Web asset destination is outside the generated desktop renderer directory')
await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })
await cp(source, destination, { recursive: true })
await copyFile(resolve(source, '_shell.html'), resolve(destination, 'index.html'))
process.stdout.write('Copied the primary web app build into the thin Electron host.\n')