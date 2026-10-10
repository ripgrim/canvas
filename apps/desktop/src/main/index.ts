import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authChannel, authSessionChangedChannel, repositoryChannel, repositoryConnectionChannel } from '../preload/contracts'
import type { AuthResponse, RepositoryConnectionResponse, RepositoryResponse } from '../preload/contracts'
import { contentSecurityPolicy, hostedContentSecurityPolicy, isTrustedSender, parseAuthRequest, parseRepositoryConnectionRequest, parseRepositoryRequest, secureWebPreferences } from './policy'
import { localCapabilityArguments, resolveEditorTarget } from './web-target'
import { RepositoryProcess } from './repo-process'
import { bundledAssetResponse, bundledScriptHashes } from './assets'
import { resolveFixtureGrant } from './fixture-grant'
import { createDocument } from '@canvas/repo-engine/document'
import { createPreviewRuntime } from '@canvas/preview-runtime'
import type { PreviewBinding } from '@canvas/preview-runtime'
import type { ProjectSnapshot, SaveResult } from '@canvas/repo-engine'
import { RepositoryConnections } from './repository-connections'
import { createElectronAuthClient } from '@canvas/auth/electron'
import { canAccessAuthenticatedProject, DesktopAuthService } from './auth-service'
import { authCallbackFromArguments, desktopAuthCallbackPath, desktopAuthClientOptions, desktopAuthScheme } from './auth-config'
import { DesktopCloudFiles } from './cloud-files'
import { desktopPackageEnvironment } from './package-environment'

protocol.registerSchemesAsPrivileged([{ scheme: 'design-editor', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])

const directory = dirname(fileURLToPath(import.meta.url))
const development = process.argv.includes('--development') && !app.isPackaged
const localPackage = desktopPackageEnvironment?.mode === 'local'
const environment: NodeJS.ProcessEnv = desktopPackageEnvironment
  ? {
      ...process.env,
      DESIGN_EDITOR_AUTH_URL: desktopPackageEnvironment.authURL,
      DESIGN_EDITOR_LOGIN_URL: desktopPackageEnvironment.loginURL,
      DESIGN_EDITOR_PREVIEW_URL: desktopPackageEnvironment.previewURL,
      DESIGN_EDITOR_ASSETS_URL: desktopPackageEnvironment.assetsURL,
    }
  : process.env
const smoke = process.env.DESIGN_EDITOR_SMOKE === '1'
let repository: RepositoryProcess | undefined
let repositoryConnections: RepositoryConnections | undefined
let authService: DesktopAuthService | undefined
let cloudFiles: DesktopCloudFiles | undefined
let editorWindow: BrowserWindow | undefined
let preview: ReturnType<typeof createPreviewRuntime> | undefined
let shutdown: Promise<void> | undefined
let shutdownComplete = false
const retiredPreviews = new Map<number, string>()
const pendingAuthCallbacks: string[] = []

function routeAuthCallback(url: string): void {
  const service = authService
  const window = editorWindow
  if (!service || !window || window.isDestroyed()) {
    pendingAuthCallbacks.splice(0, pendingAuthCallbacks.length, url)
    return
  }
  void service.handleCallback(url, window.id).catch(() => { service.rejectCallback() })
}

function registerAuthProtocol(): void {
  if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient(desktopAuthScheme, process.execPath, [resolve(process.argv[1]), ...(development ? ['--development'] : [])])
  else app.setAsDefaultProtocolClient(desktopAuthScheme)
}

registerAuthProtocol()
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
else {
  const initialAuthCallback = authCallbackFromArguments(process.argv)
  if (initialAuthCallback) pendingAuthCallbacks.push(initialAuthCallback)
  app.on('second-instance', (_event, commandLine) => {
    if (editorWindow && !editorWindow.isDestroyed()) {
      if (editorWindow.isMinimized()) editorWindow.restore()
      editorWindow.focus()
    }
    const callback = authCallbackFromArguments(commandLine)
    if (callback) routeAuthCallback(callback)
  })
  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (url.startsWith(`${desktopAuthScheme}:`)) routeAuthCallback(url)
  })
}

async function rebuildPreview(snapshot: ProjectSnapshot): Promise<void> {
  if (!preview) return
  const previous = preview.snapshot()
  const current = await preview.rebuild(previewBinding(snapshot))
  if (previous.activeGeneration !== null && previous.url && current.activeGeneration !== previous.activeGeneration) retiredPreviews.set(previous.activeGeneration, previous.url)
}

function disposeServices(): Promise<void> {
  if (shutdown) return shutdown
  repository?.dispose()
  repository = undefined
  repositoryConnections?.dispose()
  repositoryConnections = undefined
  authService?.dispose()
  authService = undefined
  cloudFiles = undefined
  const activePreview = preview
  preview = undefined
  shutdown = activePreview?.dispose() ?? Promise.resolve()
  return shutdown
}

function previewBinding(snapshot: ProjectSnapshot): PreviewBinding {
  // The bound composition document never carries drawn primitives; source bindings only read its component nodes.
  const { canvas: _canvas, ...sourceDocument } = createDocument(snapshot.atoms, snapshot.composition)
  const promoted = snapshot.atoms.find((atom) => atom.componentId === snapshot.composition.componentId && atom.status === 'bound')
  return {
    componentId: promoted?.componentId ?? snapshot.composition.id,
    entryPath: promoted?.path ?? 'src/PreviewLogin.tsx',
    exportName: promoted?.exportName ?? 'PreviewLogin',
    styles: ['src/globals.css'],
    props: {},
    sourceDocument,
    registry: snapshot.atoms.filter(atom => atom.kind === 'atom' && atom.status === 'bound').map(atom => ({ componentId: atom.componentId, entryPath: atom.path, exportName: atom.exportName })),
  }
}

async function createEditor(): Promise<void> {
  const target = resolveEditorTarget(environment.DESIGN_EDITOR_WEB_URL, development)
  const editorUrl = target.url
  if (target.localCapabilities) {
    repositoryConnections = new RepositoryConnections(app.getPath('userData'), resolve(directory, 'scan-worker.js'))
    await repositoryConnections.start()
    if (process.env.DESIGN_EDITOR_SMOKE === '1') {
      const fixtureRoot = await resolveFixtureGrant({
        defaultRoot: resolve(directory, '../../../../fixtures/component-repo'),
        argv: process.argv,
        smokeEnabled: true,
        packaged: app.isPackaged,
      })
      repository = new RepositoryProcess(resolve(directory, 'repo-worker.js'), fixtureRoot)
      await repository.start()
      const initialSnapshot = await repository.execute({ method: 'inspectFixture', args: [] }) as ProjectSnapshot
      preview = createPreviewRuntime({ repositoryRoot: fixtureRoot, editorOrigin: target.origin, executionTrust: 'fixture-only' })
      await preview.start(previewBinding(initialSnapshot))
    }
  }
  const csp = target.localCapabilities ? contentSecurityPolicy(target.development, preview?.snapshot().origin ?? null, target.development ? [] : await bundledScriptHashes(resolve(directory, '../renderer'))) : hostedContentSecurityPolicy()
  const editorSession = session.fromPartition(target.localCapabilities ? 'persist:design-editor-shell' : 'design-editor-hosted')
  if (target.localCapabilities) editorSession.protocol.handle('design-editor', (request) => bundledAssetResponse(request, resolve(directory, '../renderer'), csp))
  editorSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  editorSession.setPermissionCheckHandler(() => false)
  editorSession.on('will-download', (event) => event.preventDefault())
  editorSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType === 'mainFrame') {
      const headers = Object.entries(details.responseHeaders ?? {})
      const existingPolicies = headers.filter(([name]) => name.toLowerCase() === 'content-security-policy').flatMap(([, values]) => values)
      callback({ responseHeaders: { ...Object.fromEntries(headers.filter(([name]) => name.toLowerCase() !== 'content-security-policy')), 'Content-Security-Policy': [...existingPolicies, csp] } })
    } else callback({ responseHeaders: details.responseHeaders ?? {} })
  })
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1000,
    minHeight: 680,
    title: 'Comp Canvas',
    backgroundColor: '#f7f7f7',
    show: false,
    webPreferences: {
      ...secureWebPreferences,
      session: editorSession,
      ...(target.localCapabilities ? { preload: resolve(directory, '../preload/index.cjs'), additionalArguments: localCapabilityArguments(target) } : {}),
    },
  })
  editorWindow = window
  const authOptions = desktopAuthClientOptions(environment, development || localPackage)
  const authClient = authOptions ? createElectronAuthClient(authOptions) : null
  authService = new DesktopAuthService({
    client: authClient,
    target: { scheme: desktopAuthScheme, path: desktopAuthCallbackPath },
  })
  if (authClient && authOptions) cloudFiles = new DesktopCloudFiles(
    authClient,
    authOptions.baseURL,
    target.origin,
    environment.DESIGN_EDITOR_PREVIEW_URL?.trim() || (development || localPackage ? 'http://127.0.0.1:4318' : undefined),
    environment.DESIGN_EDITOR_ASSETS_URL?.trim() || (development || localPackage ? 'http://127.0.0.1:4322' : undefined),
  )
  authService.subscribe(value => { if (!window.isDestroyed()) window.webContents.send(authSessionChangedChannel, value) })
  await authService.start()
  window.removeMenu()
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame || event.url !== preview?.snapshot().url) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.on('did-frame-finish-load', () => {
    const activeUrls = new Set(window.webContents.mainFrame.framesInSubtree.map((frame) => frame.url))
    for (const [generation, url] of retiredPreviews) {
      if (activeUrls.has(url)) continue
      retiredPreviews.delete(generation)
      void preview?.releaseGeneration(generation).catch(() => { retiredPreviews.set(generation, url) })
    }
  })
  ipcMain.removeHandler(repositoryChannel)
  ipcMain.removeHandler(repositoryConnectionChannel)
  ipcMain.removeHandler(authChannel)
  if (target.localCapabilities) ipcMain.handle(repositoryChannel, async (event, payload: unknown): Promise<RepositoryResponse> => {
    const frame = event.senderFrame
    if (!frame || !isTrustedSender({ webContentsId: event.sender.id, isMainFrame: frame === window.webContents.mainFrame, url: frame.url }, window.webContents.id, editorUrl)) {
      return { ok: false, error: 'This window cannot access the project.' }
    }
    if (!canAccessAuthenticatedProject(authService?.getSession(), development || smoke)) return { ok: false, error: 'Sign in to access the project.' }
    try {
      const request = parseRepositoryRequest(payload)
      if (request.method === 'listFiles') {
        if (cloudFiles && authService?.getSession().status === 'signed-in') return { ok: true, value: await cloudFiles.list() }
        return { ok: true, value: process.env.DESIGN_EDITOR_SMOKE === '1' ? [{ id: 'fixture-project', name: 'Fixture', location: 'Local' }] : [] }
      }
      if (request.method === 'createFile') {
        if (!cloudFiles) throw new Error('Cloud files are unavailable.')
        return { ok: true, value: await cloudFiles.create() }
      }
      if (request.method === 'openFile' && cloudFiles?.accepts(request.args[0])) return { ok: true, value: await cloudFiles.open(request.args[0]) }
      if (request.method === 'refresh' && cloudFiles?.hasActive()) return { ok: true, value: await cloudFiles.refresh() }
      if (request.method === 'saveFile' && cloudFiles?.isActive(request.args[0].fileId)) return { ok: true, value: await cloudFiles.save(request.args[0], request.args[1]) }
      if (!repository) throw new Error('No repository grant.')
      if (request.method === 'openFile' && request.args[0] !== 'fixture-project') throw new Error('Unknown file.')
      const value = await repository.execute(request.method === 'openFile' ? { method: 'inspectFixture', args: [] } : request)
      if (request.method === 'inspectFixture' || request.method === 'openFile' || request.method === 'refresh' || request.method === 'saveFile') {
        const snapshot = value as ProjectSnapshot
        if (request.method === 'refresh') await rebuildPreview(snapshot)
        return { ok: true, value: { ...snapshot, preview: preview?.snapshot() } }
      }
      if (request.method === 'savePrepared') {
        const result = value as SaveResult
        if (result.status === 'saved') await rebuildPreview(result.snapshot)
        return { ok: true, value: { ...result, snapshot: { ...result.snapshot, preview: preview?.snapshot() } } }
      }
      return { ok: true, value }
    } catch {
      return { ok: false, error: 'The command could not finish. Refresh the project and try again.' }
    }
  })
  if (target.localCapabilities) ipcMain.handle(repositoryConnectionChannel, async (event, payload: unknown): Promise<RepositoryConnectionResponse> => {
    const frame = event.senderFrame
    if (!frame || !isTrustedSender({ webContentsId: event.sender.id, isMainFrame: frame === window.webContents.mainFrame, url: frame.url }, window.webContents.id, editorUrl)) {
      return { ok: false, error: 'This window cannot access repositories.' }
    }
    if (!canAccessAuthenticatedProject(authService?.getSession(), development || smoke)) return { ok: false, error: 'Sign in to access repositories.' }
    try {
      const request = parseRepositoryConnectionRequest(payload)
      const service = repositoryConnections
      if (!service) throw new Error('Repository connection service is unavailable.')
      if (request.method === 'pickLocal') {
        const selected = await dialog.showOpenDialog(window, { title: 'Choose a repository', buttonLabel: 'Choose repository', properties: ['openDirectory'] })
        if (selected.canceled || selected.filePaths.length !== 1) return { ok: true, value: null }
        return { ok: true, value: await service.connectLocal(selected.filePaths[0]!) }
      }
      if (request.method === 'cloneGitHub') return { ok: true, value: await service.cloneGitHub(request.args[0]) }
      if (request.method === 'scanCurrent') return { ok: true, value: await service.scanCurrent() }
      return { ok: true, value: await service.getCurrent() }
    } catch {
      return { ok: false, error: 'The repository could not be connected. Check the folder or GitHub name and try again.' }
    }
  })
  if (target.localCapabilities) ipcMain.handle(authChannel, async (event, payload: unknown): Promise<AuthResponse> => {
    const frame = event.senderFrame
    if (!frame || !isTrustedSender({ webContentsId: event.sender.id, isMainFrame: frame === window.webContents.mainFrame, url: frame.url }, window.webContents.id, editorUrl)) {
      return { ok: false, error: 'This window cannot access the account.' }
    }
    try {
      const request = parseAuthRequest(payload)
      const service = authService
      if (!service) throw new Error('Auth service is unavailable.')
      if (request.method === 'signInWithGitHub') return { ok: true, value: await service.requestSignIn(window.id) }
      if (request.method === 'signOut') return { ok: true, value: await service.signOut() }
      return { ok: true, value: service.getSession() }
    } catch {
      return { ok: false, error: 'The account command could not finish.' }
    }
  })
  const showEditor = () => {
    if (!window.isDestroyed() && !window.isVisible()) window.show()
  }
  window.once('ready-to-show', showEditor)
  window.once('closed', () => {
    ipcMain.removeHandler(repositoryChannel)
    ipcMain.removeHandler(repositoryConnectionChannel)
    ipcMain.removeHandler(authChannel)
    editorWindow = undefined
    void disposeServices()
  })
  await window.loadURL(editorUrl)
  showEditor()
  while (pendingAuthCallbacks.length) routeAuthCallback(pendingAuthCallbacks.shift()!)
}

app.on('window-all-closed', () => app.quit())
app.on('before-quit', (event) => {
  if (shutdownComplete) return
  event.preventDefault()
  void disposeServices().finally(() => { shutdownComplete = true; app.quit() })
})
if (primaryInstance) app.whenReady().then(createEditor).catch((error: unknown) => {
  console.error('Design editor startup failed:', error instanceof Error ? error.message : 'Unknown startup error')
  app.quit()
})
