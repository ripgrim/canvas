import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'dotenv'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(root, 'deploy/vercel-projects.json'), 'utf8'))
const environments = JSON.parse(readFileSync(resolve(root, 'deploy/environments.json'), 'utf8'))
const apply = process.argv.includes('--apply')
const envFile = resolve(root, optionValue('--env-file') ?? '.env.staging')
const values = parse(readFileSync(envFile))

validate(values)

const assignments = manifest.projects.flatMap(project => project.environment.map(name => ({ project, name, value: values[name] })))
if (!apply) {
  const projects = manifest.projects.map(project => ({ name: project.name, variables: project.environment }))
  process.stdout.write(`VERCEL_STAGING_ENV_EVIDENCE ${JSON.stringify({ branch: manifest.stagingBranch, projects })}\n`)
  process.stdout.write(`Validated ${assignments.length} branch-scoped variables without uploading them.\n`)
  process.exit(0)
}

run(['whoami'])
for (const { project, name, value } of assignments) {
  run([
    'env', 'add', name, 'preview', manifest.stagingBranch,
    '--project', project.name,
    '--scope', manifest.scope,
    '--force',
    '--yes',
  ], `${value}\n`)
  process.stdout.write(`Configured ${name} for ${project.name} on ${manifest.stagingBranch}.\n`)
}
process.stdout.write(`Configured ${assignments.length} staging variables across ${manifest.projects.length} Vercel projects.\n`)

function validate(input) {
  if (manifest.stagingBranch !== environments.staging.branch) fail('Staging branch configuration drifted.')
  const missing = manifest.projects.flatMap(project => project.environment.filter(name => !(name in input) || !input[name]?.trim()))
  if (missing.length) fail(`Staging environment is incomplete: ${[...new Set(missing)].join(', ')}`)
  exact(input, 'AUTH_COOKIE_DOMAIN', 'canvas.ripgrim.com')
  exact(input, 'AUTH_COOKIE_PREFIX', 'comp-canvas-staging')

  const productionOrigins = new Set(Object.values(environments.production.origins))
  for (const project of manifest.projects) {
    for (const name of project.environment) {
      const value = input[name]
      if (productionOrigins.has(value)) fail(`${name} points at a production origin.`)
    }
  }

  const expected = environments.staging.origins
  exact(input, 'BETTER_AUTH_URL', expected.web)
  exact(input, 'LOGIN_URL', expected.login)
  exact(input, 'APP_URL', expected.web)
  exact(input, 'ASSETS_ORIGIN', expected.assets)
  exact(input, 'VITE_API_URL', expected.web)
  exact(input, 'VITE_APP_URL', expected.web)
  exact(input, 'VITE_API_ORIGIN', expected.web)
  exact(input, 'VITE_LOGIN_ORIGIN', expected.login)
  exact(input, 'VITE_PREVIEW_ORIGIN', expected.preview)
  exact(input, 'VITE_ASSETS_ORIGIN', expected.assets)
  exact(input, 'VITE_SYNC_ORIGIN', expected.sync)
  exact(input, 'VITE_COLLABORATION_BUILD_ID', input.COLLABORATION_BUILD_ID)
  exact(input, 'GITHUB_APP_AUTHORIZATION_CALLBACK_URL', `${expected.api}/api/github/authorization/callback`)

  const trustedOrigins = new Set(input.AUTH_TRUSTED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean))
  if (trustedOrigins.size !== 2 || !trustedOrigins.has(expected.web) || !trustedOrigins.has(expected.login)) {
    fail('AUTH_TRUSTED_ORIGINS must contain only the staging editor and login origins.')
  }
}

function exact(input, name, expected) {
  if (input[name] !== expected) fail(`${name} must be ${expected}.`)
}

function optionValue(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) fail(`${name} requires a path.`)
  return value
}

function command(args, input) {
  if (process.platform !== 'win32') return spawnSync('vercel', args, { cwd: root, encoding: 'utf8', input })
  const commandLine = ['vercel', ...args.map(quoteWindowsArgument)].join(' ')
  return spawnSync(commandLine, { cwd: root, encoding: 'utf8', windowsHide: true, shell: true, input })
}

function quoteWindowsArgument(value) {
  if (/[\r\n%]/.test(value)) fail('Vercel command argument is invalid.')
  return `"${value.replaceAll('"', '""')}"`
}

function run(args, input) {
  const result = command(args, input)
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  if (result.status !== 0) fail(`vercel ${args.join(' ')} failed.`)
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
