import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { cp, lstat, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { expect, it } from 'vitest'
import { createPreviewRuntime } from '../src/index.js'
import { fixtureRegistry } from './fixture-registry.js'

async function removeFixtureDirectory(path: string, prefix: string) {
  const tempRoot = await realpath(tmpdir())
  const target = await realpath(path)
  const location = relative(tempRoot, target)
  if (!location || location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location) || !basename(target).startsWith(prefix)) throw new Error('Native fixture cleanup target is outside its temporary directory')
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
}

it('AT-PRV-006, AT-APP-003, and AT-APP-005 real Electron DOM selection, appearance, and component style restoration', async () => {
  const repositoryRoot = resolve(import.meta.dirname, '../../../fixtures/component-repo')
  const fixtureInput = await readFile(join(repositoryRoot, 'src/atoms/Input.tsx'), 'utf8')
  const fixtureButton = await readFile(join(repositoryRoot, 'src/atoms/Button.tsx'), 'utf8')
  const dynamicFixture = await mkdtemp(join(tmpdir(), 'design-editor-selection-fixture-'))
  await cp(join(repositoryRoot, 'src'), join(dynamicFixture, 'src'), { recursive: true })
  await cp(join(repositoryRoot, 'package.json'), join(dynamicFixture, 'package.json'))
  await cp(join(repositoryRoot, 'pnpm-lock.yaml'), join(dynamicFixture, 'pnpm-lock.yaml'))
  await symlink(join(repositoryRoot, 'node_modules'), join(dynamicFixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(dynamicFixture, 'src/atoms/Input.tsx'), `import { useState, type ComponentProps } from 'react'
export function Input(props: ComponentProps<'input'>) {
  const [generation, setGeneration] = useState(0)
  return <input {...props} key={generation} onDoubleClick={() => setGeneration(value => value + 1)} className="fixture-input" />
}
`)
  // A component that owns its own inline background and border, so appearance overrides must restore them exactly.
  await writeFile(join(dynamicFixture, 'src/atoms/Button.tsx'), `import type { ComponentProps } from 'react'
export type ButtonProps = ComponentProps<'button'> & { variant?: 'primary' | 'quiet' }
export function Button({ variant = 'primary', ...props }: ButtonProps) {
  return <button {...props} data-variant={variant} className={['fixture-button', props.className].filter(Boolean).join(' ')} style={{ background: 'rgb(18, 52, 86)', border: '3px solid rgb(1, 2, 3)', ...props.style }} />
}
`)
  const parent = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(`<iframe sandbox="allow-scripts allow-same-origin" src="${previewUrl}" style="width:800px;height:700px;border:0"></iframe>`) })
  let previewUrl = ''
  await new Promise<void>(resolveListen => parent.listen(0, '127.0.0.1', resolveListen))
  const address = parent.address()
  if (!address || typeof address === 'string') throw new Error('Parent fixture server did not bind')
  const editorOrigin = `http://127.0.0.1:${address.port}`
  const preview = createPreviewRuntime({ repositoryRoot: dynamicFixture, editorOrigin, executionTrust: 'fixture-only' })
  const userData = await mkdtemp(join(tmpdir(), 'design-editor-selection-test-'))
  const nativeApp = await mkdtemp(join(tmpdir(), 'design-editor-selection-app-'))
  try {
    await cp(resolve(import.meta.dirname, 'selection-electron.mjs'), join(nativeApp, 'main.mjs'))
    await writeFile(join(nativeApp, 'package.json'), JSON.stringify({ name: 'design-editor-selection-test', version: '1.0.0', type: 'module', main: './main.mjs' }))
    const result = await preview.start({ componentId: 'fixture-login', entryPath: 'src/PreviewLogin.tsx', exportName: 'PreviewLogin', styles: ['src/globals.css'], registry: fixtureRegistry })
    expect(result.status).toBe('ready')
    previewUrl = result.url!
    const requireFromDesktop = createRequire(resolve(import.meta.dirname, '../../../apps/desktop/package.json'))
    const executable = requireFromDesktop('electron') as string
    const env: NodeJS.ProcessEnv = {}
    const osVariables = new Set(['systemroot', 'systemdrive', 'windir', 'temp', 'tmp', 'path', 'pathext', 'userprofile', 'localappdata', 'appdata', 'comspec', 'programdata', 'programfiles', 'programfiles(x86)', 'programw6432', 'commonprogramfiles', 'commonprogramfiles(x86)', 'commonprogramw6432', 'os', 'username', 'userdomain', 'computername', 'number_of_processors', 'processor_architecture', 'sessionname'])
    for (const [name, value] of Object.entries(process.env)) if (osVariables.has(name.toLowerCase()) && value) env[name] = value
    await new Promise<void>((resolveChild, reject) => {
      const child = spawn(executable, [nativeApp, `--selection-editor-url=${editorOrigin}`, `--selection-preview-url=${previewUrl}`, `--selection-generation=${result.activeGeneration}`, `--user-data-dir=${userData}`], { cwd: nativeApp, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timeout = setTimeout(() => { timedOut = true; child.kill() }, 25_000)
      child.stdout.on('data', data => { stdout += String(data) })
      child.stderr.on('data', data => { if (stderr.length < 8000) stderr += String(data) })
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('close', async code => { clearTimeout(timeout); if (code === 0 && !timedOut) resolveChild(); else { const diagnostic = await readFile(join(userData, 'selection-error.txt'), 'utf8').catch(() => stderr.trim() || stdout.trim()); reject(new Error(`${timedOut ? 'Native selection test timed out' : `Native selection test exited ${code}`}\n${diagnostic}`)) } })
    })
    const output = await readFile(join(userData, 'selection-result.json'), 'utf8')
    expect(JSON.parse(output)).toEqual({ ok: true, originalMode: true, nativeInput: true, exactColor: true, staleRejection: true, replacement: true, foreignBinding: true, resize: true, canvasFill: true, appearancePixels: true, componentAppearance: true, componentRestore: true, componentDrift: true, hostileFill: true, deletion: true, disposal: true })
    expect(await readFile(join(repositoryRoot, 'src/atoms/Input.tsx'), 'utf8')).toBe(fixtureInput)
    expect(await readFile(join(repositoryRoot, 'src/atoms/Button.tsx'), 'utf8')).toBe(fixtureButton)
  } finally {
    await preview.dispose()
    parent.closeAllConnections()
    await new Promise<void>(resolveClose => parent.close(() => resolveClose()))
    await removeFixtureDirectory(userData, 'design-editor-selection-test-')
    await removeFixtureDirectory(nativeApp, 'design-editor-selection-app-')
    const dependencyLink = join(dynamicFixture, 'node_modules')
    if (!(await lstat(dependencyLink)).isSymbolicLink()) throw new Error('Native fixture dependency cleanup target is not its expected junction')
    await unlink(dependencyLink)
    await removeFixtureDirectory(dynamicFixture, 'design-editor-selection-fixture-')
  }
}, 45_000)
