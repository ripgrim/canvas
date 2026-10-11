import { app, BrowserWindow, ipcMain, protocol, safeStorage } from 'electron'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ElectronAuthClient } from '@canvas/auth/electron'
import { createElectronSessionStorage } from '../../../../packages/auth/src/electron-storage'
import { authChannel } from '../../src/preload/contracts'
import type { AuthResponse } from '../../src/preload/contracts'
import { DesktopAuthService } from '../../src/main/auth-service'
import { parseAuthRequest, secureWebPreferences } from '../../src/main/policy'

protocol.registerSchemesAsPrivileged([{ scheme: 'design-editor', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

const directory = dirname(fileURLToPath(import.meta.url))
const callbackTarget = { scheme: 'com.comp-canvas.desktop', path: '/auth/callback' } as const
const callbackToken = Buffer.from(JSON.stringify({ identifier: 'A'.repeat(32), state: 'B'.repeat(16) })).toString('base64url')
const cookieKey = 'design-editor-auth.cookie'
const mainSecret = 'main-process-session-secret'
const rawServerUser = {
  id: 'u1',
  name: 'Ada',
  email: 'ada@example.test',
  image: 'https://images.example.test/ada.png',
  sessionToken: 'renderer-must-not-see-session-token',
  cookie: 'renderer-must-not-see-cookie',
  databaseUrl: 'postgres://renderer-must-not-see-database',
  providerSecret: 'renderer-must-not-see-provider-secret',
}

type RendererReport = Readonly<{
  phase: 'first' | 'reload'
  before: unknown
  after: unknown
  surface: readonly string[]
  globals: Readonly<{ requireType: string; authClientType: string; cookieType: string }>
}>

const disk = new Map<string, string>()
const storage = createElectronSessionStorage({
  backend: {
    get: name => disk.get(name),
    set: (name, value) => { disk.set(name, value) },
  },
  protection: safeStorage,
  platform: process.platform,
})
const unsafeUser = rawServerUser as unknown as NonNullable<Awaited<ReturnType<ElectronAuthClient['getUser']>>>
const client: ElectronAuthClient = Object.freeze({
  requestSignIn: async () => undefined,
  authenticate: async () => {
    storage.setItem(cookieKey, `better-auth.session_token=${mainSecret}`)
    return unsafeUser
  },
  getUser: async () => storage.getItem(cookieKey) ? unsafeUser : null,
  signOut: async () => { storage.setItem(cookieKey, '{}') },
  request: async () => new Response(null, { status: 404 }),
})
const service = new DesktopAuthService({ client, target: callbackTarget, now: () => 1_000 })
const reports: RendererReport[] = []

function fail(error: unknown): void {
  process.stderr.write(`AUTH_ELECTRON_BOUNDARY_ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function validateFinalEvidence(): void {
  const first = reports[0]
  const reload = reports[1]
  assert(first?.phase === 'first' && reload?.phase === 'reload', 'Renderer did not cross the expected first-load and reload phases.')
  const firstBefore = first.before as { status?: unknown }
  const firstAfter = first.after as { status?: unknown }
  const reloadBefore = reload.before as { status?: unknown }
  assert(firstBefore.status === 'signed-out', 'First renderer did not begin signed out.')
  assert(firstAfter.status === 'signed-in', 'First renderer did not receive the signed-in session.')
  assert(reloadBefore.status === 'signed-in', 'Reloaded renderer could not use the main-held session.')
  assert(storage.getItem(cookieKey) === `better-auth.session_token=${mainSecret}`, 'Main process could not recover its protected session.')

  const rendererPayload = JSON.stringify(reports.flatMap(report => [report.before, report.after]))
  for (const forbidden of ['sessionToken', 'cookie', 'databaseUrl', 'providerSecret', mainSecret, 'renderer-must-not-see']) {
    assert(!rendererPayload.includes(forbidden), `Renderer payload leaked ${forbidden}.`)
  }
  for (const report of reports) {
    assert(report.globals.requireType === 'undefined', 'Renderer acquired Node require.')
    assert(report.globals.authClientType === 'undefined', 'Renderer acquired an auth client.')
    assert(report.globals.cookieType === 'undefined', 'Renderer acquired a cookie surface.')
    assert(report.surface.includes('getAuthSession') && report.surface.includes('signInWithGitHub') && report.surface.includes('signOut'), 'Actual preload auth methods were not exposed.')
    assert(!report.surface.includes('getCookie') && !report.surface.includes('getToken') && !report.surface.includes('getAuthClient'), 'Preload exposed main-held auth material.')
  }

  const persisted = disk.get(cookieKey)
  assert(typeof persisted === 'string' && persisted.startsWith('canvas-safe-storage:v1:'), 'Session was not stored in the protected envelope.')
  assert(!persisted.includes(mainSecret), 'Persisted storage contains plaintext session material.')
  const evidence = {
    firstRenderer: firstBefore.status,
    authenticatedRenderer: firstAfter.status,
    reloadedRenderer: reloadBefore.status,
    actualPreloadAuthSurface: first.surface.filter(name => name === 'getAuthSession' || name === 'signInWithGitHub' || name === 'signOut' || name === 'onAuthSessionChanged'),
    nodeRequireExposed: false,
    authClientExposed: false,
    cookieOrTokenExposed: false,
    protectedSessionRecoveredInMain: true,
    persistedPlaintext: false,
  }
  process.stdout.write(`AUTH_ELECTRON_BOUNDARY_EVIDENCE ${JSON.stringify(evidence)}\n`, () => process.exit(0))
}

async function run(): Promise<void> {
  await app.whenReady()
  assert(safeStorage.isEncryptionAvailable(), 'Electron safeStorage is unavailable on this acceptance host.')
  await service.start()

  const html = await readFile(join(directory, 'renderer.html'))
  const renderer = await readFile(join(directory, 'renderer.js'))
  protocol.handle('design-editor', request => {
    const pathname = new URL(request.url).pathname
    if (pathname === '/' || pathname === '/index.html') return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    if (pathname === '/renderer.js') return new Response(renderer, { headers: { 'content-type': 'text/javascript; charset=utf-8' } })
    return new Response('Not found', { status: 404 })
  })

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      ...secureWebPreferences,
      preload: join(directory, 'preload.cjs'),
      additionalArguments: ['--design-editor-local-capabilities', '--design-editor-editor-url=design-editor://app/'],
    },
  })

  ipcMain.handle(authChannel, async (event, payload: unknown): Promise<AuthResponse> => {
    try {
      assert(event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame, 'Unexpected IPC sender.')
      const request = parseAuthRequest(payload)
      if (request.method === 'getSession') return { ok: true, value: service.getSession() }
      if (request.method === 'signOut') return { ok: true, value: await service.signOut() }
      await service.requestSignIn(window.id)
      return { ok: true, value: await service.handleCallback(`${callbackTarget.scheme}:${callbackTarget.path}#token=${callbackToken}`, window.id) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Auth boundary failed.' }
    }
  })

  window.webContents.on('console-message', details => {
    const message = details.message
    if (!message.startsWith('AUTH_RENDERER_REPORT ')) return
    try {
      const report = JSON.parse(message.slice('AUTH_RENDERER_REPORT '.length)) as RendererReport
      reports.push(report)
      if (reports.length === 1) window.webContents.reloadIgnoringCache()
      else {
        validateFinalEvidence()
        service.dispose()
      }
    } catch (error) {
      fail(error)
    }
  })
  window.webContents.on('render-process-gone', (_event, details) => fail(new Error(`Renderer exited unexpectedly: ${details.reason}`)))
  await window.loadURL('design-editor://app/')
}

void run().catch(fail)
