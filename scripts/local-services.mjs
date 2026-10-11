import { readFileSync } from 'node:fs'

const workspaceVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
if (typeof workspaceVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(workspaceVersion)) throw new Error('The workspace version is invalid.')

export const localOrigins = Object.freeze({
  web: 'http://127.0.0.1:4317',
  preview: 'http://127.0.0.1:4318',
  login: 'http://127.0.0.1:4319',
  api: 'http://127.0.0.1:4320',
  sync: 'http://127.0.0.1:4321',
  assets: 'http://127.0.0.1:4322',
  thumbnailRenderer: 'http://127.0.0.1:4323',
  thumbnailJobs: 'http://127.0.0.1:4324',
  syncRoom: 'http://127.0.0.1:4325',
  syncCoordinator: 'http://127.0.0.1:4326',
})

export const localEnvironment = Object.freeze({
  BETTER_AUTH_URL: localOrigins.api,
  LOGIN_URL: localOrigins.login,
  APP_URL: localOrigins.web,
  VITE_API_URL: localOrigins.api,
  VITE_APP_URL: localOrigins.web,
  VITE_API_ORIGIN: localOrigins.api,
  VITE_LOGIN_ORIGIN: localOrigins.login,
  VITE_PREVIEW_ORIGIN: localOrigins.preview,
  VITE_ASSETS_ORIGIN: localOrigins.assets,
  THUMBNAIL_RENDERER_ORIGIN: localOrigins.thumbnailRenderer,
  VITE_SYNC_ORIGIN: 'ws://127.0.0.1:4321',
  SYNC_ROOM_RUNTIME_ORIGIN: localOrigins.syncRoom,
  COLLABORATION_BUILD_ID: workspaceVersion,
  DESIGN_EDITOR_AUTH_URL: localOrigins.api,
  DESIGN_EDITOR_LOGIN_URL: localOrigins.login,
  DESIGN_EDITOR_PREVIEW_URL: localOrigins.preview,
  DESIGN_EDITOR_ASSETS_URL: localOrigins.assets,
  API_BASE_URL: localOrigins.api,
  API_ORIGIN: localOrigins.api,
  ASSETS_ORIGIN: localOrigins.assets,
  ALLOWED_ORIGINS: `${localOrigins.web},${localOrigins.login}`,
})

export const localServices = Object.freeze([
  service('web', 'Web', '@canvas/web', 'dev', 4317, `${localOrigins.web}/`),
  service('preview', 'Preview', '@canvas/web', 'dev:preview', 4318, `${localOrigins.preview}/`, ['CANVAS_VERIFIED_COMPONENT_REGISTRY']),
  service('login', 'Login', '@canvas/login', 'dev', 4319, `${localOrigins.login}/`),
  service('api', 'API', '@canvas/api', 'dev', 4320, `${localOrigins.api}/healthz`, [
    'DATABASE_URL', 'BETTER_AUTH_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET',
    'BETTER_AUTH_URL', 'LOGIN_URL', 'APP_URL', 'AUTH_TRUSTED_ORIGINS',
    'AUTH_COOKIE_DOMAIN', 'API_SERVICE_TOKEN', 'COLLABORATION_ADMISSION_SERVICE_TOKEN', 'COLLABORATION_BUILD_ID', 'THUMBNAIL_SERVICE_TOKEN',
    'ASSETS_ORIGIN',
    'CANVAS_VERIFIED_REGISTRY_FINGERPRINT',
    'GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_CLIENT_ID',
    'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY',
    'GITHUB_APP_WEBHOOK_SECRET', 'GITHUB_APP_CREDENTIAL_ENCRYPTION_KEY',
    'GITHUB_APP_AUTHORIZATION_CALLBACK_URL',
  ]),
  service('sync', 'Sync', '@canvas/sync-worker', 'dev', 4321, `${localOrigins.sync}/healthz`, [
    'COLLABORATION_ADMISSION_SERVICE_TOKEN', 'COLLABORATION_BUILD_ID', 'API_ORIGIN', 'ALLOWED_ORIGINS',
    'SYNC_COORDINATOR_INTERNAL_SECRET',
  ], {}, ['--show-interactive-dev-session=false']),
  service('assets', 'Assets', '@canvas/workers', 'dev', 4322, `${localOrigins.assets}/`, [], {}, [
    '--show-interactive-dev-session=false',
  ], [404]),
  service('thumbnail-renderer', 'Thumbnail renderer', '@canvas/thumbnail-renderer', 'dev', 4323, `${localOrigins.thumbnailRenderer}/thumbnail-renderer`, ['CANVAS_VERIFIED_COMPONENT_REGISTRY']),
  service('thumbnail-jobs', 'Thumbnail jobs', '@canvas/thumbnail-jobs', 'dev', 4324, `${localOrigins.thumbnailJobs}/healthz`, [
    'API_ORIGIN', 'ASSETS_ORIGIN', 'THUMBNAIL_RENDERER_ORIGIN',
    'THUMBNAIL_SERVICE_TOKEN', 'THUMBNAIL_JOB_TRIGGER_TOKEN',
  ]),
  service('sync-room', 'Sync room', '@canvas/sync-room-core', 'dev', 4325, `${localOrigins.syncRoom}/readyz`, [
    'DATABASE_URL', 'ALLOWED_ORIGINS', 'SYNC_ROOM_TICKET_SECRET', 'SYNC_ROOM_CHECKPOINT_DIR',
    'SYNC_MAX_MESSAGE_BYTES', 'SYNC_HOST_MAX_ROOMS', 'SYNC_HOST_MAX_PENDING_UPGRADES',
    'SYNC_ROOM_HANDSHAKE_TIMEOUT_MS', 'SYNC_HOST_STARTUP_TIMEOUT_MS', 'SYNC_HOST_SHUTDOWN_TIMEOUT_MS',
  ]),
  service('sync-coordinator', 'Sync coordinator', '@canvas/sync-coordinator', 'dev', 4326, `${localOrigins.syncCoordinator}/`, [
    'ALLOWED_ORIGINS', 'SYNC_COORDINATOR_INTERNAL_SECRET', 'SYNC_ROOM_TICKET_SECRET', 'SYNC_ROOM_RUNTIME_ORIGIN',
  ], {}, ['--show-interactive-dev-session=false'], [403]),
])

export const sharedBuildPackages = Object.freeze([
  '@canvas/preview-runtime',
  '@canvas/repo-engine',
  '@canvas/scanner',
  '@canvas/auth',
  '@canvas/github-app',
  '@canvas/database',
  '@canvas/cloud-document',
  '@canvas/cloud-client',
  '@canvas/files',
  '@canvas/sync-protocol',
  '@canvas/sync-client',
  '@canvas/sync-service',
  '@canvas/sync-room-core',
  '@canvas/repository',
  '@canvas/thumbnail-capture',
])

export const requiredLocalEnvironment = Object.freeze([
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
])

function service(id, label, packageName, script, port, readyUrl, environment = [], fixedEnvironment = {}, trailingArgs = [], readyStatuses = [200]) {
  return Object.freeze({
    id,
    label,
    packageName,
    script,
    port,
    readyUrl,
    readyStatuses: Object.freeze(readyStatuses),
    environment: Object.freeze(environment),
    fixedEnvironment: Object.freeze(fixedEnvironment),
    trailingArgs: Object.freeze(trailingArgs),
  })
}

