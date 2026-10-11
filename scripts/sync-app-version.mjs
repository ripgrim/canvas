import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageManifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
if (typeof packageManifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageManifest.version)) throw new Error('The application version is invalid.')
await writeFile(resolve(root, 'packages/tracking/src/version.generated.ts'), `export const appVersion = '${packageManifest.version}'\n`, 'utf8')
