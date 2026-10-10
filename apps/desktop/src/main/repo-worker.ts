import { realpath } from 'node:fs/promises'
import { createRepoEngine } from '@canvas/repo-engine'
import { scanShadcnRepository } from '@canvas/scanner/shadcn'
import { validatePreviewFiles } from '@canvas/preview-runtime'
import { parseRepositoryRequest } from './policy'
import type { RepositoryRequest, RepositoryResult } from '../preload/contracts'

const requestedRoot = process.argv[2]
if (!requestedRoot || !process.parentPort) throw new Error('Missing repository grant.')
const grant = await realpath(requestedRoot)
const engine = await createRepoEngine(grant, {
  validatePreview: (input) => validatePreviewFiles(
    { repositoryRoot: input.root, editorOrigin: 'design-editor://app', executionTrust: 'fixture-only' },
    { ...input.binding, styles: ['src/globals.css'] },
    input.files,
  ),
})
const port = process.parentPort
let queue: Promise<void> = Promise.resolve()

async function execute(request: RepositoryRequest): Promise<RepositoryResult> {
  if (await realpath(requestedRoot!) !== grant) throw new Error('Repository grant changed.')
  switch (request.method) {
    case 'listFiles':
    case 'createFile':
    case 'openFile': throw new Error('Shell file commands cannot run in the repository worker.')
    case 'inspectFixture': return engine.inspectFixture()
    case 'scanShadcn': return scanShadcnRepository(grant)
    case 'refresh': return engine.refresh()
    case 'prepareLabelPadding': return engine.prepareLabelPadding(request.args[0])
    case 'prepareToken': return engine.prepareToken(request.args[0])
    case 'preparePromotion': return engine.preparePromotion(request.args[0])
    case 'prepareUndo': return engine.prepareUndo(request.args[0])
    case 'prepareRedo': return engine.prepareRedo(request.args[0])
    case 'saveFile': return engine.saveFile(request.args[0], request.args[1])
    case 'savePrepared': return engine.savePrepared(request.args[0], request.args[1])
  }
}

port.on('message', ({ data }: { data: unknown }) => {
  queue = queue.then(async () => {
    if (!data || typeof data !== 'object') return
    const message = data as { id?: unknown; request?: unknown }
    if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id)) return
    try {
      const request = parseRepositoryRequest(message.request)
      const value = await execute(request)
      port.postMessage({ id: message.id, result: { ok: true, value } })
    } catch {
      port.postMessage({ id: message.id, result: { ok: false, error: 'The repository command could not finish. Refresh the project and review its diagnostics.' } })
    }
  })
})
port.postMessage({ ready: true })
