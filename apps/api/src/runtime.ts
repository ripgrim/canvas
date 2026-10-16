import { getHostedAuth } from '@canvas/auth/hosted'
import { desktopAuthProtocolScheme } from '@canvas/auth'
import { createPostgresControlPlane, createPostgresPool } from '@canvas/database/postgres'
import { createPostgresCollaborationPersistence } from '@canvas/database'
import { createApiApp, type ApiApp } from './app.js'
import { createPostgresGitHubApiServices } from './github.js'
import { createPostgresCollaborationAdmissionAuthority } from './collaboration-admission.js'
import { createHostedLegacyAssetUploader, createLegacyDocumentExternalizer } from './legacy-assets.js'

export type ApiRuntime = Readonly<{
  app: ApiApp
  pool: ReturnType<typeof createPostgresPool>
}>

let runtime: ApiRuntime | undefined

export function getApiRuntime(environment: NodeJS.ProcessEnv = process.env): ApiRuntime {
  if (runtime) return runtime
  const pool = createPostgresPool(required(environment, 'DATABASE_URL'))
  const github = githubServices(pool, environment)
  const store = createPostgresControlPlane(pool)
  const serviceToken = required(environment, 'API_SERVICE_TOKEN')
  const revision = deploymentRevision(environment)
  const app = createApiApp({
    auth: getHostedAuth(environment),
    store,
    serviceToken,
    repositoryJobServiceToken: required(environment, 'REPOSITORY_JOB_SERVICE_TOKEN'),
    hostedPreviewBuildServiceToken: required(environment, 'HOSTED_PREVIEW_BUILD_SERVICE_TOKEN'),
    hostedPreviewWriteSecret: required(environment, 'HOSTED_PREVIEW_WRITE_SECRET'),
    assetsOrigin: required(environment, 'ASSETS_ORIGIN'),
    collaborationAdmissionServiceToken: required(environment, 'COLLABORATION_ADMISSION_SERVICE_TOKEN'),
    collaborationBuildId: required(environment, 'COLLABORATION_BUILD_ID'),
    collaborationAllowedOrigins: editorOrigins(environment),
    registryFingerprint: required(environment, 'CANVAS_VERIFIED_REGISTRY_FINGERPRINT'),
    thumbnailServiceToken: required(environment, 'THUMBNAIL_SERVICE_TOKEN'),
    hostedPreviewPublisherServiceToken: required(environment, 'HOSTED_PREVIEW_PUBLISHER_SERVICE_TOKEN'),
    hostedPreviewCapabilitySecret: required(environment, 'HOSTED_PREVIEW_CAPABILITY_SECRET'),
    hostedPreviewOrigin: required(environment, 'HOSTED_PREVIEW_ORIGIN'),
    collaborationAuthority: createPostgresCollaborationAdmissionAuthority(createPostgresCollaborationPersistence(pool)),
    legacyDocumentExternalizer: createLegacyDocumentExternalizer({
      store,
      upload: createHostedLegacyAssetUploader({ assetsOrigin: required(environment, 'ASSETS_ORIGIN'), serviceToken }),
    }),
    ...(revision ? { deploymentRevision: revision } : {}),
    allowedOrigins: apiAllowedOrigins(environment),
    ...(github ? { github } : {}),
  })
  runtime = Object.freeze({ app, pool })
  return runtime
}

function deploymentRevision(environment: NodeJS.ProcessEnv): string | undefined {
  const value = environment.VERCEL_GIT_COMMIT_SHA?.trim() || environment.GITHUB_SHA?.trim()
  return value && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : undefined
}

export function apiAllowedOrigins(environment: NodeJS.ProcessEnv): readonly string[] {
  const webOrigins = [required(environment, 'LOGIN_URL'), ...editorOrigins(environment)]
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => new URL(value).origin)
  return Object.freeze([`${desktopAuthProtocolScheme}:/`, ...new Set(webOrigins)])
}

function editorOrigins(environment: NodeJS.ProcessEnv): readonly string[] {
  return Object.freeze([...new Set(required(environment, 'APP_URL')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => new URL(value).origin))])
}

export function handleApiRequest(request: Request): Promise<Response> {
  return getApiRuntime().app(request)
}

export function restoreVercelRequestPath(request: Request): Request {
  const url = new URL(request.url)
  const path = url.searchParams.get('__canvas_path')
  if (path === null) return request
  url.searchParams.delete('__canvas_path')
  const normalized = path.replace(/^\/+/, '')
  url.pathname = `/${normalized}`
  return new Request(url, request)
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim()
  if (!value || /[\r\n]/.test(value)) throw new Error(`Missing ${name}.`)
  return value
}

function githubServices(pool: ReturnType<typeof createPostgresPool>, environment: NodeJS.ProcessEnv) {
  const names = ['GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_WEBHOOK_SECRET', 'GITHUB_APP_CREDENTIAL_ENCRYPTION_KEY', 'GITHUB_APP_AUTHORIZATION_CALLBACK_URL'] as const
  const values = Object.fromEntries(names.map(name => [name, environment[name]?.trim()])) as Record<(typeof names)[number], string | undefined>
  if (names.every(name => !values[name])) return undefined
  if (names.some(name => !values[name])) throw new Error(`${names.join(', ')} must be configured together.`)
  return createPostgresGitHubApiServices(pool, {
    appId: values.GITHUB_APP_ID!, appSlug: values.GITHUB_APP_SLUG!, clientId: values.GITHUB_APP_CLIENT_ID!, clientSecret: values.GITHUB_APP_CLIENT_SECRET!,
    privateKey: values.GITHUB_APP_PRIVATE_KEY!, webhookSecret: values.GITHUB_APP_WEBHOOK_SECRET!, credentialEncryptionKey: values.GITHUB_APP_CREDENTIAL_ENCRYPTION_KEY!, authorizationCallbackUrl: values.GITHUB_APP_AUTHORIZATION_CALLBACK_URL!,
  })
}

