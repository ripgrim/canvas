import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pnpm = process.env.npm_execpath
if (!pnpm) throw new Error('Run this command through pnpm test:home-auth-parity.')

const services = [
  { label: 'Web fixture', packageName: '@canvas/web', port: 4417 },
  { label: 'Login fixture', packageName: '@canvas/login', port: 4419 },
]
const children = new Set()

function isolatedEnvironment() {
  const environment = { ...process.env }
  for (const name of Object.keys(environment)) {
    if (name.startsWith('VITE_')) delete environment[name]
  }
  return environment
}

function launch(service) {
  const child = spawn(process.execPath, [pnpm, '--filter', service.packageName, 'exec', 'vite', '--host', '127.0.0.1', '--port', String(service.port), '--strictPort'], {
    cwd: root,
    env: isolatedEnvironment(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.output = ''
  child.stdout.on('data', chunk => { child.output += chunk })
  child.stderr.on('data', chunk => { child.output += chunk })
  children.add(child)
  return child
}

async function ready(service, child) {
  const url = `http://127.0.0.1:${service.port}/`
  let lastError
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${service.label} stopped before readiness.\n${child.output}`)
    try {
      const response = await fetch(url)
      if (response.ok) return url
    } catch (error) { lastError = error }
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }
  throw new Error(`${service.label} did not become ready.\n${child.output}`, { cause: lastError })
}

function run(script, environment) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [script], { cwd: root, env: { ...process.env, ...environment }, windowsHide: true, stdio: 'inherit' })
    child.once('error', rejectRun)
    child.once('exit', code => code === 0 ? resolveRun() : rejectRun(new Error(`${script} failed with exit code ${code}.`)))
  })
}

function stopChild(child) {
  if (!child.pid || child.exitCode !== null) return Promise.resolve()
  if (process.platform !== 'win32') {
    child.kill('SIGTERM')
    return Promise.resolve()
  }
  return new Promise(resolveStop => {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    killer.once('error', () => { child.kill(); resolveStop() })
    killer.once('exit', () => resolveStop())
  })
}

const launched = services.map(service => ({ service, child: launch(service) }))
try {
  const [homeUrl, loginUrl] = await Promise.all(launched.map(({ service, child }) => ready(service, child)))
  const environment = { CANVAS_HOME_URL: homeUrl, CANVAS_LOGIN_URL: loginUrl }
  await run('apps/web/tests/home-screen.mjs', environment)
  await run('packages/editor/src/features/home/home-auth-parity.test.mjs', environment)
  console.log(`HOME_AUTH_PARITY_EVIDENCE ${JSON.stringify({ homeUrl, loginUrl, isolated: true })}`)
} finally {
  await Promise.all([...children].map(stopChild))
}
