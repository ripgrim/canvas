import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const argumentsList = process.argv.slice(2)
if (argumentsList.includes('--help')) {
  console.log('Usage: node apps/web/tests/hydration-startup.mjs [--project-root <built project>]')
  process.exit(0)
}
let requestedRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
for (let index = 0; index < argumentsList.length; index++) {
  const argument = argumentsList[index]
  if (argument === '--project-root' && argumentsList[index + 1]) requestedRoot = resolve(argumentsList[++index])
  else if (argument.startsWith('--project-root=')) requestedRoot = resolve(argument.slice('--project-root='.length))
  else throw new Error(`Unknown or incomplete argument: ${argument}`)
}

const projectRoot = await realpath(requestedRoot)
const desktopRoot = join(projectRoot, 'apps', 'desktop')
const fixtureSource = join(projectRoot, 'fixtures', 'component-repo')
const mainPath = join(desktopRoot, 'dist', 'main', 'index.js')
const htmlPath = join(desktopRoot, 'dist', 'renderer', 'index.html')
const require = createRequire(join(desktopRoot, 'package.json'))
const electronPath = require('electron')
const artifactHashes = Object.fromEntries(await Promise.all([mainPath, htmlPath].map(async path => [relative(projectRoot, path), createHash('sha256').update(await readFile(path)).digest('hex')])))
const originalSources = await sourceHashes(fixtureSource)
const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'design-editor-hydration-')))
const temporaryFixture = join(temporaryRoot, 'workspace', 'fixtures', 'component-repo')
const dependencyLink = join(temporaryFixture, 'node_modules')
let linked = false
let child
let childExited = false
let report
const cleanupErrors = []

async function sourceHashes(root) {
  const files = {}
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.design-editor') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files[relative(root, path).split(sep).join('/')] = createHash('sha256').update(await readFile(path)).digest('hex')
      else throw new Error(`Unexpected fixture entry: ${path}`)
    }
  }
  await visit(root)
  return files
}

async function observeStartup(configuration) {
  const { createRequire } = await import('node:module')
  const require = createRequire(configuration.packagePath)
  const { app } = require('electron')
  const records = []
  const observers = new Map()
  const marker = 'DESIGN_EDITOR_HYDRATION_OBSERVER_NEGATIVE_CONTROL'
  let overflow = false
  let complete = false
  let controlObserved = false
  let documentResponse
  let lastProbe
  const delay = milliseconds => new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
  const record = (kind, text, url = '') => {
    if (String(text).includes(marker)) return
    if (records.length >= 100 || String(text).length > 8000) overflow = true
    if (records.length < 100) records.push({ kind, text: String(text).slice(0, 8000), url: String(url).slice(0, 1000) })
  }
  app.setPath('userData', configuration.profilePath)
  app.setPath('sessionData', configuration.profilePath)
  app.on('web-contents-created', (_event, contents) => {
    try {
      contents.debugger.attach('1.3')
      contents.debugger.on('message', (_messageEvent, method, parameters) => {
        if (method === 'Runtime.exceptionThrown') {
          const details = parameters.exceptionDetails
          const description = details.exception?.description ?? details.text
          if (String(description).includes(marker)) controlObserved = true
          else record('exception', description, details.url)
        }
        if (method === 'Log.entryAdded' && parameters.entry.level === 'error') record('log-error', parameters.entry.text, parameters.entry.url)
        if (method === 'Runtime.consoleAPICalled' && parameters.type === 'error') record('console-error', parameters.args.map(value => value.description ?? value.value ?? value.type).join(' '))
        if (method === 'Network.responseReceived' && parameters.type === 'Document' && parameters.response.url === 'design-editor://app/') {
          documentResponse = { url: parameters.response.url, status: parameters.response.status, headers: parameters.response.headers }
        }
      })
      contents.on('render-process-gone', (_goneEvent, details) => record('renderer-gone', JSON.stringify(details)))
      contents.on('did-fail-load', (_loadEvent, code, description, url, isMainFrame) => {
        if (isMainFrame) record('load-error', `${code}: ${description}`, url)
      })
      const enabled = Promise.all(['Runtime.enable', 'Log.enable', 'Network.enable'].map(method => contents.debugger.sendCommand(method)))
      observers.set(contents, enabled)
      enabled.catch(error => record('observer-error', error.message))
    } catch (error) {
      record('observer-error', error.message)
    }
  })
  const finish = result => {
    if (complete) return
    complete = true
    clearTimeout(deadline)
    process.stdout.write(`HYDRATION_RESULT ${JSON.stringify({ ...result, records, overflow, controlObserved, documentResponse, observedWebContents: observers.size, observerUrls: [...observers.keys()].map(contents => contents.isDestroyed() ? '[destroyed]' : contents.getURL()), lastProbe })}\n`)
    app.quit()
  }
  const deadline = setTimeout(() => finish({ status: 'failed', reason: 'Startup observation timed out.' }), 100_000)
  try {
    await import(configuration.mainUrl)
    let shell
    let mounted
    for (let attempt = 0; attempt < 360; attempt++) {
      if (complete) return
      shell = [...observers.keys()].find(contents => !contents.isDestroyed() && contents.getURL() === 'design-editor://app/')
      if (shell) {
        await observers.get(shell)
        const probe = await shell.debugger.sendCommand('Runtime.evaluate', {
          expression: `({url:location.href,ready:document.readyState,title:document.title,buttons:[...document.querySelectorAll('button')].map(button=>button.textContent?.trim()),bodyLength:document.body?.innerText.length??0})`,
          returnByValue: true,
        })
        if (probe.exceptionDetails) throw new Error('Read-only shell probe threw an exception.')
        const value = probe.result.value
        lastProbe = value
        if (value?.ready === 'complete' && value.bodyLength > 50 && value.buttons?.includes('Open fixture')) { mounted = value; break }
      }
      await delay(200)
    }
    if (!mounted) throw new Error('The production editor did not mount its Open fixture control.')
    await delay(1500)
    await shell.debugger.sendCommand('Runtime.evaluate', { expression: `setTimeout(()=>{throw new Error(${JSON.stringify(marker)})},0)` })
    for (let attempt = 0; attempt < 40 && !controlObserved; attempt++) await delay(50)
    if (!controlObserved) throw new Error('The early exception observer did not capture its negative control.')
    if (!documentResponse) throw new Error('The early network observer missed the production document response.')
    const csp = Object.entries(documentResponse.headers).filter(([name]) => name.toLowerCase() === 'content-security-policy').map(([, value]) => String(value)).join('; ')
    const scriptDirective = csp.split(';').map(value => value.trim()).find(value => value.startsWith('script-src '))
    if (!scriptDirective || !scriptDirective.includes("'self'") || !/'sha256-[A-Za-z0-9+/]{43}='/.test(scriptDirective)) throw new Error('Production script CSP is missing self or an inline SHA256 hash.')
    if (scriptDirective.includes("'unsafe-inline'") || scriptDirective.includes("'unsafe-eval'") || /(?:^|\s)\*(?:\s|$)/.test(scriptDirective)) throw new Error('Production script CSP is permissive.')
    if (!csp.includes("object-src 'none'") || !csp.includes("base-uri 'none'")) throw new Error('Production CSP is missing object or base restrictions.')
    finish({ status: records.length || overflow ? 'failed' : 'passed', mounted, csp, electronVersion: process.versions.electron, observedWebContents: observers.size })
  } catch (error) {
    finish({ status: 'failed', reason: error instanceof Error ? error.message : String(error) })
  }
}

try {
  await cp(fixtureSource, temporaryFixture, { recursive: true, filter: path => !['node_modules', '.design-editor'].includes(basename(path)) })
  await cp(join(projectRoot, 'tsconfig.base.json'), join(temporaryRoot, 'workspace', 'tsconfig.base.json'))
  await symlink(await realpath(join(fixtureSource, 'node_modules')), dependencyLink, process.platform === 'win32' ? 'junction' : 'dir')
  linked = true
  const profilePath = join(temporaryRoot, 'profile')
  await mkdir(profilePath)
  const bootstrap = join(temporaryRoot, 'startup.mjs')
  await writeFile(bootstrap, `await (${observeStartup.toString()})(${JSON.stringify({ packagePath: join(desktopRoot, 'package.json'), mainUrl: pathToFileURL(mainPath).href, profilePath })})\n`)
  const env = { ...process.env, DESIGN_EDITOR_SMOKE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.DESIGN_EDITOR_WEB_URL
  child = spawn(electronPath, [bootstrap, `--smoke-fixture-root=${temporaryFixture}`, `--user-data-dir=${profilePath}`], { cwd: projectRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let outputOverflow = false
  const append = (previous, chunk) => {
    const value = previous + String(chunk)
    if (value.length > 128_000) outputOverflow = true
    return value.slice(0, 128_000)
  }
  child.stdout.on('data', chunk => { stdout = append(stdout, chunk) })
  child.stderr.on('data', chunk => { stderr = append(stderr, chunk) })
  const exit = await new Promise((resolveExit, reject) => {
    const deadline = setTimeout(() => { child.kill(); reject(new Error('Electron exceeded its 120-second process deadline.')) }, 120_000)
    child.once('error', error => { clearTimeout(deadline); reject(error) })
    child.once('close', (code, signal) => { childExited = true; clearTimeout(deadline); resolveExit({ code, signal }) })
  })
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith('HYDRATION_RESULT '))
  assert.equal(lines.length, 1, `Expected one bootstrap result. stdout=${stdout}; stderr=${stderr}`)
  report = { ...JSON.parse(lines[0].slice('HYDRATION_RESULT '.length)), projectRoot, artifactHashes, exit, outputOverflow, stderr }
  assert.equal(outputOverflow, false, 'Process output exceeded the diagnostic limit.')
  assert.equal(exit.code, 0, 'Electron exited unsuccessfully.')
  assert.equal(report.status, 'passed', 'Production startup reported a hydration, CSP, mount, or observer failure.')
} catch (error) {
  report = { ...report, status: 'failed', failure: error instanceof Error ? error.message : String(error), projectRoot, artifactHashes }
  process.exitCode = 1
} finally {
  if (child && !childExited) {
    child.kill()
    cleanupErrors.push('Electron did not exit cleanly; temporary data retained for safe inspection.')
  }
  try {
    assert.deepEqual(await sourceHashes(fixtureSource), originalSources, 'The checked-in fixture source changed during the run.')
    report.fixtureSourceUnchanged = true
  } catch (error) { cleanupErrors.push(error.message) }
  if (!child || childExited) {
    try {
      const canonicalTemporary = await realpath(temporaryRoot)
      const contained = relative(await realpath(tmpdir()), canonicalTemporary)
      assert(canonicalTemporary === temporaryRoot && contained && contained !== '..' && !contained.startsWith(`..${sep}`) && !isAbsolute(contained) && basename(canonicalTemporary).startsWith('design-editor-hydration-'))
      if (linked) await unlink(dependencyLink)
      await rm(canonicalTemporary, { recursive: true, force: true })
      report.temporaryDataRemoved = true
    } catch (error) { cleanupErrors.push(error.message) }
  }
  if (cleanupErrors.length) { report.status = 'failed'; report.cleanupErrors = cleanupErrors; process.exitCode = 1 }
  console.log(JSON.stringify(report, null, 2))
}
