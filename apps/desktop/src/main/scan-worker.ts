import { realpath } from 'node:fs/promises'
import { scanShadcnRepository } from '@canvas/scanner/shadcn'

const requestedRoot = process.argv[2]
if (!requestedRoot || !process.parentPort) throw new Error('Missing repository grant.')
const grant = await realpath(requestedRoot)
const port = process.parentPort

try {
  if (await realpath(requestedRoot) !== grant) throw new Error('Repository grant changed.')
  port.postMessage({ ok: true, value: await scanShadcnRepository(grant) })
} catch {
  port.postMessage({ ok: false, error: 'The repository could not be scanned. Review the selected folder and try again.' })
}
