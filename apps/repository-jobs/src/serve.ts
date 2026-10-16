import { createServer } from 'node:http'
import { createGitHubRepositorySnapshotPort, createHostedRepositoryQueueProcessor, createHostedRepositoryScanner, createHttpHostedDocsSnapshotPort, createHttpHostedRepositoryQueue } from './index.js'
import { createBlumeDocsPreparer, createHostedDocsPrepareProcessor, createHttpHostedDocsPrepareQueue } from './docs-worker.js'
import { createGitHubHostedDocsWriter, createHostedDocsSaveProcessor, createHttpHostedDocsSaveQueue } from './docs-save-worker.js'
import { createDockerHostedDocsValidator, parseHostedDocsValidationProfile } from './docs-sandbox.js'
import { createHostedPreviewBuildPublisher, createHttpHostedPreviewArtifactStorage, createHttpHostedPreviewRegistrar } from './hosted-build.js'
import { createDockerHostedPreviewSandbox } from './hosted-sandbox.js'
import { createHostedPreviewBuildQueueProcessor, createHttpHostedPreviewBuildQueue } from './hosted-worker.js'

const required = (name: string): string => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

const apiOrigin = required('API_ORIGIN')
const repositoryJobServiceToken = required('REPOSITORY_JOB_SERVICE_TOKEN')
const sandbox = createDockerHostedPreviewSandbox({ image: required('HOSTED_PREVIEW_BUILDER_IMAGE') })
const scanProcessor = createHostedRepositoryQueueProcessor({
  scanner: createHostedRepositoryScanner(),
  queue: createHttpHostedRepositoryQueue({ apiOrigin, serviceToken: repositoryJobServiceToken }),
})
const docsValidator = createDockerHostedDocsValidator({
  image: required('HOSTED_DOCS_VALIDATOR_IMAGE'),
  profile: parseHostedDocsValidationProfile(JSON.parse(required('HOSTED_DOCS_VALIDATOR_PROFILE'))),
})
const docsProcessor = createHostedDocsPrepareProcessor({
  queue: createHttpHostedDocsPrepareQueue({ apiOrigin, serviceToken: repositoryJobServiceToken }),
  snapshot: createHttpHostedDocsSnapshotPort({ apiOrigin, serviceToken: repositoryJobServiceToken }),
  preparer: createBlumeDocsPreparer(docsValidator),
})
const docsSaveProcessor = createHostedDocsSaveProcessor({
  queue: createHttpHostedDocsSaveQueue({ apiOrigin, serviceToken: repositoryJobServiceToken }),
  writer: createGitHubHostedDocsWriter(),
})
const registrar = createHttpHostedPreviewRegistrar({ apiOrigin, serviceToken: required('HOSTED_PREVIEW_PUBLISHER_SERVICE_TOKEN') })
const buildProcessor = createHostedPreviewBuildQueueProcessor({
  queue: createHttpHostedPreviewBuildQueue({ apiOrigin, serviceToken: required('HOSTED_PREVIEW_BUILD_SERVICE_TOKEN') }),
  snapshot: createGitHubRepositorySnapshotPort(),
  publisher(job) {
    return createHostedPreviewBuildPublisher({
      sandbox,
      registrar,
      storage: createHttpHostedPreviewArtifactStorage({
        origin: job.artifactOrigin,
        capability: job.artifactCapability,
        jobId: job.id,
        leaseId: job.leaseId,
        artifactId: job.artifactId,
        stagingId: job.stagingId,
      }),
    })
  },
})
const port = Number(process.env.PORT ?? 4327)
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PORT is invalid.')
const host = process.env.HOST?.trim() || '127.0.0.1'
if (host !== '127.0.0.1' && host !== '0.0.0.0') throw new Error('HOST is invalid.')

const server = createServer((request, response) => {
  response.statusCode = request.method === 'GET' && request.url === '/healthz' ? 200 : 404
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.end(JSON.stringify(response.statusCode === 200 ? { ok: true } : { error: { code: 'not_found', message: 'Not found.' } }))
})

let stopping = false
server.listen(port, host, () => {
  process.stdout.write(`Repository jobs: http://${host}:${port}/\n`)
  void processQueue('Repository scan', scanProcessor)
  void processQueue('Hosted documentation prepare', docsProcessor)
  void processQueue('Hosted documentation save', docsSaveProcessor)
  void processQueue('Hosted preview build', buildProcessor)
})
const stop = () => { stopping = true; server.close(() => process.exit(0)) }
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

async function processQueue(label: string, processor: Readonly<{ runOnce(): Promise<'idle' | 'completed'> }>): Promise<void> {
  while (!stopping) {
    try {
      const result = await processor.runOnce()
      await wait(result === 'idle' ? 1_000 : 0)
    } catch (error) {
      process.stderr.write(`${label} attempt failed: ${error instanceof Error ? error.message : String(error)}\n`)
      await wait(2_000)
    }
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
