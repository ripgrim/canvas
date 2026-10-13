import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron'
import electronUpdater from 'electron-updater'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { authChannel, authSessionChangedChannel, collaborationChangedChannel, collaborationChannel, fileChangedChannel, repositoryChannel, repositoryConnectionChannel, updateChangedChannel, updateChannel } from '../preload/contracts'
import type { AuthResponse, CollaborationResponse, RepositoryConnectionResponse, RepositoryResponse, UpdateResponse } from '../preload/contracts'
import { contentSecurityPolicy, hostedContentSecurityPolicy, isTrustedSender, parseAuthRequest, parseCollaborationRequest, parseRepositoryConnectionRequest, parseRepositoryRequest, parseUpdateRequest, secureWebPreferences } from './policy'
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
import { ConnectedPreviewService } from './connected-preview'
import { shadcnPreviewPropRule } from '@canvas/scanner/preview-registry'
import { createDesktopCollaborationStore, desktopCollaborationClientId } from './collaboration-store'
import { DesktopUpdateService } from './update-service'

const { autoUpdater } = electronUpdater

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
      VITE_APP_URL: desktopPackageEnvironment.appURL,
      VITE_SYNC_ORIGIN: desktopPackageEnvironment.syncURL,
      VITE_COLLABORATION_BUILD_ID: desktopPackageEnvironment.collaborationBuildId,
    }
  : process.env
const smoke = process.env.DESIGN_EDITOR_SMOKE === '1'
const startupSmoke = process.env.DESIGN_EDITOR_STARTUP_SMOKE === '1'
let repository: RepositoryProcess | undefined
let repositoryConnections: RepositoryConnections | undefined
let authService: DesktopAuthService | undefined
let cloudFiles: DesktopCloudFiles | undefined
let editorWindow: BrowserWindow | undefined
let preview: ReturnType<typeof createPreviewRuntime> | undefined
let connectedPreview: ConnectedPreviewService | undefined
let desktopUpdate: DesktopUpdateService | undefined
let shutdown: Promise<void> | undefined
let shutdownComplete = false
const retiredPreviews = new Map<number, string>()
const pendingAuthCallbacks: string[] = []

function ipcFailure(scope: string, error: unknown, message: string): Readonly<{ ok: false; error: string; reference: string }> {
  const reference = randomUUID()
  const failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { name: 'UnknownError', message: String(error) }
  console.error(JSON.stringify({ level: 'error', event: 'desktop_command_failed', scope, reference, error: failure }))
  return { ok: false, error: message, reference }
}

function routeAuthCallback(url: string): void {
  const service = authService
  const window = editorWindow
  if (!service || !window || window.isDestroyed()) {
    pendingAuthCallbacks.splice(0, pendingAuthCallbacks.length, url)
    return
  }
  void service.handleCallback(url, window.id).catch(error => {
    const failure = ipcFailure('auth_callback', error, 'The sign-in response was invalid.')
    service.rejectCallback(failure.reference)
  })
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
  cloudFiles?.dispose()
  cloudFiles = undefined
  desktopUpdate?.stop()
  const activePreview = preview
  preview = undefined
  const activeConnectedPreview = connectedPreview
  connectedPreview = undefined
  shutdown = Promise.all([activePreview?.dispose(), activeConnectedPreview?.dispose()].filter((value): value is Promise<void> => Boolean(value))).then(() => undefined)
  return shutdown
}

function previewBinding(snapshot: ProjectSnapshot): PreviewBinding {
  // The bound composition document never carries drawn primitives; source bindings only read its component nodes.
  const { canvas: _canvas, ...legacySourceDocument } = createDocument(snapshot.atoms, snapshot.composition)
  const sourceDocument = { ...legacySourceDocument, version: 2 as const }
  const promoted = snapshot.atoms.find((atom) => atom.componentId === snapshot.composition.componentId && atom.status === 'bound')
  const selectedBinding = {
    componentId: promoted?.componentId ?? snapshot.composition.id,
    entryPath: promoted?.path ?? 'src/PreviewLogin.tsx',
    exportName: promoted?.exportName ?? 'PreviewLogin',
  }
  const usedNamesByComponent = new Map<string, Set<string>>()
  const usedValuesByComponent = new Map<string, Map<string, Set<string | number | boolean>>>()
  for (const node of Object.values(sourceDocument.nodes)) {
    const names = usedNamesByComponent.get(node.componentId) ?? new Set<string>()
    const values = usedValuesByComponent.get(node.componentId) ?? new Map<string, Set<string | number | boolean>>()
    for (const [name, value] of Object.entries(node.props)) {
      names.add(name)
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        const propValues = values.get(name) ?? new Set<string | number | boolean>()
        propValues.add(value)
        values.set(name, propValues)
      }
    }
    for (const name of Object.keys(node.children)) names.add(name)
    usedNamesByComponent.set(node.componentId, names)
    usedValuesByComponent.set(node.componentId, values)
  }
  const componentSchema = (atom: ProjectSnapshot['atoms'][number]) => {
    const usedNames = usedNamesByComponent.get(atom.componentId) ?? new Set<string>()
    const slots = [...new Set(atom.slots ?? atom.props
      .filter(prop => usedNames.has(prop.name) && (prop.name === 'children' || /React(?:Node|Element)/.test(prop.type)))
      .map(prop => prop.name))]
    const slotNames = new Set(slots)
    const props = Object.fromEntries(atom.props.flatMap(prop => {
      if (!usedNames.has(prop.name) || slotNames.has(prop.name)) return []
      const values = [...(usedValuesByComponent.get(atom.componentId)?.get(prop.name) ?? [])]
      const rule = shadcnPreviewPropRule(prop.type) ?? (values.length ? { kind: 'enum' as const, values } : null)
      if (!rule) throw new Error(`The preview cannot represent ${atom.exportName}.${prop.name}.`)
      return [[prop.name, rule]]
    }))
    return { props, slots }
  }
  const registry = [
    { ...selectedBinding, ...(promoted ? componentSchema(promoted) : { props: {}, slots: [] }) },
    ...snapshot.atoms
      .filter(atom => atom.kind === 'atom' && atom.status === 'bound' && atom.componentId !== selectedBinding.componentId)
      .map(atom => ({ componentId: atom.componentId, entryPath: atom.path, exportName: atom.exportName, ...componentSchema(atom) })),
  ]
  return {
    ...selectedBinding,
    styles: ['src/globals.css'],
    props: {},
    sourceDocument,
    registry,
  }
}

async function createEditor(): Promise<void> {
  const target = resolveEditorTarget(environment.DESIGN_EDITOR_WEB_URL, development)
  const editorUrl = target.url
  const cloudPreviewOrigin = environment.DESIGN_EDITOR_PREVIEW_URL?.trim() || (development || localPackage ? 'http://127.0.0.1:4318' : undefined)
  let connectedPreviewOrigin: string | null = null
  if (target.localCapabilities) {
    connectedPreview = new ConnectedPreviewService(target.origin)
    connectedPreviewOrigin = await connectedPreview.start()
    repositoryConnections = new RepositoryConnections(
      app.getPath('userData'),
      resolve(directory, 'scan-worker.js'),
      'git',
      async registry => {
        await connectedPreview!.activate(registry)
      },
    )
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
  const previewOrigins = [preview?.snapshot().origin, connectedPreviewOrigin, cloudPreviewOrigin].filter((origin): origin is string => Boolean(origin))
  const csp = target.localCapabilities ? contentSecurityPolicy(target.development, previewOrigins, target.development ? [] : await bundledScriptHashes(resolve(directory, '../renderer'))) : hostedContentSecurityPolicy()
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
      ...(target.localCapabilities ? { preload: resolve(directory, '../preload/index.cjs'), additionalArguments: localCapabilityArguments(target, smoke) } : {}),
    },
  })
  editorWindow = window
  desktopUpdate = new DesktopUpdateService({
    updater: autoUpdater,
    currentVersion: app.getVersion(),
    channel: desktopPackageEnvironment?.updateChannel ?? 'stable',
    feedURL: desktopPackageEnvironment?.updateURL.trim() || null,
    enabled: app.isPackaged && desktopPackageEnvironment?.updateChannel !== null,
    prepareInstall: disposeServices,
  })
  desktopUpdate.subscribe(snapshot => { if (!window.isDestroyed()) window.webContents.send(updateChangedChannel, snapshot) })
  desktopUpdate.start()
  window.on('focus', () => desktopUpdate?.checkIfStale())
  const authOptions = desktopAuthClientOptions(environment, development || localPackage)
  const authClient = authOptions ? createElectronAuthClient(authOptions) : null
  authService = new DesktopAuthService({
    client: authClient,
    target: { scheme: desktopAuthScheme, path: desktopAuthCallbackPath },
  })
  if (authClient && authOptions) {
    const syncOrigin = environment.VITE_SYNC_ORIGIN?.trim() || (development || localPackage ? 'ws://127.0.0.1:4321' : '')
    const buildId = environment.VITE_COLLABORATION_BUILD_ID?.trim() || (development || localPackage ? app.getVersion() : '')
    const requestOrigin = environment.VITE_APP_URL?.trim() || (target.origin.startsWith('http') ? target.origin : '')
    if (!syncOrigin || !buildId || !requestOrigin) throw new Error('Desktop collaboration configuration is incomplete.')
    const userData = app.getPath('userData')
    cloudFiles = new DesktopCloudFiles(
      authClient,
      authOptions.baseURL,
      target.origin,
      cloudPreviewOrigin,
      environment.DESIGN_EDITOR_ASSETS_URL?.trim() || (development || localPackage ? 'http://127.0.0.1:4322' : undefined),
      connectedPreview,
      {
        syncOrigin,
        buildId,
        requestOrigin: new URL(requestOrigin).origin,
        clientId: await desktopCollaborationClientId(resolve(userData, 'collaboration-client-id')),
        accountId: () => authService?.getSession().user?.id ?? null,
        durableStore: createDesktopCollaborationStore(resolve(userData, 'collaboration-cache')),
      },
    )
    cloudFiles.subscribeFile(snapshot => { if (!window.isDestroyed()) window.webContents.send(fileChangedChannel, snapshot) })
    cloudFiles.subscribeCollaboration(() => { if (!window.isDestroyed() && cloudFiles) window.webContents.send(collaborationChangedChannel, cloudFiles.collaborationSnapshot()) })
  }
  authService.subscribe(value => {
    if (!window.isDestroyed()) window.webContents.send(authSessionChangedChannel, value)
    if (value.status === 'signed-out' || value.status === 'revoked') void cloudFiles?.signOut().catch(error => ipcFailure('collaboration_sign_out', error, 'Collaboration cleanup could not finish.'))
  })
  await authService.start()
  window.removeMenu()
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-frame-navigate', (event) => {
    const allowed = new Set([preview?.snapshot().url, connectedPreview?.snapshot().url, cloudFiles?.activePreviewUrl()].filter((value): value is string => Boolean(value)))
    if (event.isMainFrame || !allowed.has(event.url)) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.on('did-frame-finish-load', () => {
    const activeUrls = new Set(window.webContents.mainFrame.framesInSubtree.map((frame) => frame.url))
    for (const [generation, url] of retiredPreviews) {
      if (activeUrls.has(url)) continue
      retiredPreviews.delete(generation)
      void preview?.releaseGeneration(generation).catch(error => {
        retiredPreviews.set(generation, url)
        ipcFailure('preview_release', error, 'The preview could not release its retired build.')
      })
    }
  })
  ipcMain.removeHandler(repositoryChannel)
  ipcMain.removeHandler(repositoryConnectionChannel)
  ipcMain.removeHandler(authChannel)
  ipcMain.removeHandler(collaborationChannel)
  ipcMain.removeHandler(updateChannel)
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
      if (request.method === 'saveFile' && cloudFiles?.isActive(request.args[0].fileId)) return { ok: true, value: await cloudFiles.save(request.args[0], request.args[1], request.args[2]) }
      if (!repository) throw new Error('No repository grant.')
      if (request.method === 'openFile' && request.args[0] !== 'fixture-project') throw new Error('Unknown file.')
      const value = await repository.execute(request.method === 'openFile' ? { method: 'inspectFixture', args: [] } : request.method === 'saveFile' ? { method: 'saveFile', args: [request.args[0], request.args[1]] } : request)
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
    } catch (error) {
      return ipcFailure('repository', error, 'The command could not finish. Refresh the project and try again.')
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
    } catch (error) {
      return ipcFailure('repository_connection', error, 'The repository could not be connected. Check the folder or GitHub name and try again.')
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
    } catch (error) {
      return ipcFailure('auth', error, 'The account command could not finish.')
    }
  })
  if (target.localCapabilities) ipcMain.handle(collaborationChannel, async (event, payload: unknown): Promise<CollaborationResponse> => {
    const frame = event.senderFrame
    if (!frame || !isTrustedSender({ webContentsId: event.sender.id, isMainFrame: frame === window.webContents.mainFrame, url: frame.url }, window.webContents.id, editorUrl)) return { ok: false, error: 'This window cannot access collaboration.' }
    try {
      const request = parseCollaborationRequest(payload)
      const service = cloudFiles
      if (!service && request.method === 'getSnapshot') {
        return {
          ok: true,
          value: {
            status: 'unavailable',
            shellState: null,
            localClientId: null,
            localProfile: null,
            canMutate: false,
            canManageShare: false,
            participants: [],
            agents: [],
            error: null,
          },
        }
      }
      if (!service && (request.method === 'retry' || request.method === 'leave')) return { ok: true, value: null }
      if (!service) throw new Error('Collaboration is unavailable.')
      if (request.method === 'getSnapshot') return { ok: true, value: service.collaborationSnapshot() }
      if (request.method === 'updateAwareness') { service.updateAwareness(request.args[0], request.args[1]); return { ok: true, value: null } }
      if (request.method === 'retry') { service.retry(); return { ok: true, value: null } }
      service.leave()
      return { ok: true, value: null }
    } catch (error) {
      return ipcFailure('collaboration', error, 'The collaboration command could not finish.')
    }
  })
  if (target.localCapabilities) ipcMain.handle(updateChannel, async (event, payload: unknown): Promise<UpdateResponse> => {
    const frame = event.senderFrame
    if (!frame || !isTrustedSender({ webContentsId: event.sender.id, isMainFrame: frame === window.webContents.mainFrame, url: frame.url }, window.webContents.id, editorUrl)) return { ok: false, error: 'This window cannot access updates.', reference: randomUUID() }
    try {
      const request = parseUpdateRequest(payload)
      const service = desktopUpdate
      if (!service) throw new Error('The update service is unavailable.')
      if (request.method === 'check') return { ok: true, value: await service.check() }
      if (request.method === 'download') return { ok: true, value: await service.download() }
      if (request.method === 'install') return { ok: true, value: await service.install() }
      return { ok: true, value: service.getSnapshot() }
    } catch (error) {
      return ipcFailure('update', error, 'The update command could not finish.')
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
    ipcMain.removeHandler(collaborationChannel)
    ipcMain.removeHandler(updateChannel)
    editorWindow = undefined
    void disposeServices()
  })
  await window.loadURL(editorUrl)
  showEditor()
  while (pendingAuthCallbacks.length) routeAuthCallback(pendingAuthCallbacks.shift()!)
}

app.on('window-all-closed', () => app.quit())
app.on('before-quit', (event) => {
  if (desktopUpdate?.isInstalling()) return
  if (shutdownComplete) return
  event.preventDefault()
  void disposeServices().finally(() => { shutdownComplete = true; app.quit() })
})
if (primaryInstance) app.whenReady().then(() => startupSmoke ? app.quit() : createEditor()).catch((error: unknown) => {
  console.error('Design editor startup failed:', error instanceof Error ? error.message : 'Unknown startup error')
  app.quit()
})
