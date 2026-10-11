import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(root, 'deploy/vercel-projects.json'), 'utf8'))
const apply = process.argv.includes('--apply')
validate(manifest)

if (!apply) {
  run(['whoami'])
  const projects = manifest.projects.map(project => inspectProject(project))
  process.stdout.write(`VERCEL_PROJECT_EVIDENCE ${JSON.stringify({ scope: manifest.scope, gitDeployments: manifest.gitDeployments, projects })}\n`)
  process.stdout.write('Verified existing Vercel projects without deploying them.\n')
  process.exit(0)
}

run(['whoami'])
for (const project of manifest.projects) {
  const exists = command(['project', 'inspect', project.name, '--scope', manifest.scope]).status === 0
  if (!exists) run(['project', 'add', project.name, '--scope', manifest.scope])
  const update = ['project', 'update', project.name, '--scope', manifest.scope, '--framework', project.framework, '--build-command', project.buildCommand]
  if (project.outputDirectory) update.push('--output-directory', project.outputDirectory)
  run(update)
  const projectDirectory = resolve(root, project.rootDirectory)
  run(['link', '--yes', '--scope', manifest.scope, '--project', project.name, '--cwd', projectDirectory])
  removeBroadEnvironmentIgnore(projectDirectory)
  const connected = command(['git', 'connect', manifest.repository, '--scope', manifest.scope, '--cwd', projectDirectory])
  if (connected.status !== 0 && !`${connected.stdout}\n${connected.stderr}`.includes('already connected')) fail(`Could not connect ${project.name} to Git.`)
  run(['api', `/v9/projects/${project.name}`, '--scope', manifest.scope, '-X', 'PATCH', '-f', `rootDirectory=${project.rootDirectory}`, '--silent'])
  run(['api', `/v9/projects/${project.name}`, '--scope', manifest.scope, '-X', 'PATCH', '--input', '-', '--silent'], JSON.stringify({ gitProviderOptions: { createDeployments: manifest.gitDeployments } }))
  configureBranchDomain(project)
  inspectProject(project)
}
process.stdout.write(`Configured ${manifest.projects.length} Vercel projects without deploying.\n`)

function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Vercel project manifest is invalid.')
  if (typeof value.scope !== 'string' || !value.scope || typeof value.repository !== 'string' || !value.repository.startsWith('https://github.com/')) fail('Vercel project manifest identity is invalid.')
  if (value.gitDeployments !== 'enabled' || value.productionBranch !== 'main' || value.stagingBranch !== 'staging') fail('Vercel branch deployment settings are invalid.')
  if (!Array.isArray(value.projects) || !value.projects.length) fail('Vercel project manifest has no projects.')
  const names = new Set()
  const services = new Set()
  const domains = new Set()
  for (const project of value.projects) {
    if (!project || typeof project !== 'object' || Array.isArray(project)) fail('Vercel project entry is invalid.')
    if (!/^[a-z0-9-]+$/.test(project.name) || names.has(project.name)) fail(`Vercel project name is invalid or repeated: ${project.name}`)
    if (!/^[a-z0-9-]+$/.test(project.service) || services.has(project.service)) fail(`Vercel service is invalid or repeated: ${project.service}`)
    if (!/^apps\/[a-z0-9-]+$/.test(project.rootDirectory)) fail(`Vercel root directory is invalid: ${project.rootDirectory}`)
    if (!['vite', 'other'].includes(project.framework) || typeof project.buildCommand !== 'string' || !project.buildCommand) fail(`Vercel build settings are invalid: ${project.name}`)
    if (![project.productionDomain, project.stagingDomain].every(domain => typeof domain === 'string' && /^[a-z0-9.-]+$/.test(domain)) || project.productionDomain === project.stagingDomain) fail(`Vercel domain settings are invalid: ${project.name}`)
    if (domains.has(project.productionDomain) || domains.has(project.stagingDomain)) fail(`Vercel domain is repeated: ${project.name}`)
    if (!Array.isArray(project.environment) || project.environment.some(name => !/^[A-Z][A-Z0-9_]*$/.test(name))) fail(`Vercel environment contract is invalid: ${project.name}`)
    const config = JSON.parse(readFileSync(resolve(root, project.rootDirectory, 'vercel.json'), 'utf8'))
    if (config.buildCommand !== project.buildCommand) fail(`Vercel build command drifted for ${project.name}.`)
    if ((config.outputDirectory ?? undefined) !== (project.outputDirectory ?? undefined)) fail(`Vercel output directory drifted for ${project.name}.`)
    names.add(project.name)
    services.add(project.service)
    domains.add(project.productionDomain)
    domains.add(project.stagingDomain)
  }
}

function inspectProject(project) {
  const state = command(['api', `/v9/projects/${project.name}`, '--scope', manifest.scope, '--raw'])
  if (state.status !== 0) fail(`Could not verify ${project.name}.`)
  const current = JSON.parse(state.stdout)
  if (current.rootDirectory !== project.rootDirectory || current.buildCommand !== project.buildCommand || (current.outputDirectory ?? undefined) !== (project.outputDirectory ?? undefined)) {
    fail(`Vercel project settings drifted for ${project.name}.`)
  }
  if (current.gitProviderOptions?.createDeployments !== manifest.gitDeployments) {
    fail(`Vercel Git deployment setting drifted for ${project.name}.`)
  }
  if (current.link?.productionBranch !== manifest.productionBranch) fail(`Vercel production branch drifted for ${project.name}.`)
  const stagingDomain = inspectDomain(project, project.stagingDomain)
  if (stagingDomain.gitBranch !== manifest.stagingBranch) fail(`Vercel staging branch domain drifted for ${project.name}.`)
  return {
    service: project.service,
    name: project.name,
    rootDirectory: current.rootDirectory,
    gitDeployments: current.gitProviderOptions.createDeployments,
    productionBranch: current.link.productionBranch,
    stagingDomain: stagingDomain.name,
    latestDeployments: Array.isArray(current.latestDeployments) ? current.latestDeployments.length : 0,
  }
}

function configureBranchDomain(project) {
  const existing = command(['api', `/v9/projects/${project.name}/domains/${project.stagingDomain}`, '--scope', manifest.scope, '--raw'])
  if (existing.status !== 0) {
    run(['api', `/v9/projects/${project.name}/domains`, '--scope', manifest.scope, '-X', 'POST', '--input', '-', '--silent'], JSON.stringify({ name: project.stagingDomain, gitBranch: manifest.stagingBranch }))
    return
  }
  run(['api', `/v9/projects/${project.name}/domains/${project.stagingDomain}`, '--scope', manifest.scope, '-X', 'PATCH', '--input', '-', '--silent'], JSON.stringify({ gitBranch: manifest.stagingBranch }))
}

function inspectDomain(project, domain) {
  const state = command(['api', `/v9/projects/${project.name}/domains/${domain}`, '--scope', manifest.scope, '--raw'])
  if (state.status !== 0) fail(`Could not verify ${domain} on ${project.name}.`)
  return JSON.parse(state.stdout)
}

function removeBroadEnvironmentIgnore(projectDirectory) {
  const ignorePath = resolve(projectDirectory, '.gitignore')
  const source = readFileSync(ignorePath, 'utf8')
  const lines = source.split(/\r?\n/).filter(line => line.trim() !== '.env*')
  const next = `${lines.filter((line, index) => line || index < lines.length - 1).join('\n').replace(/\n+$/, '')}\n`
  if (next !== source.replaceAll('\r\n', '\n')) writeFileSync(ignorePath, next, 'utf8')
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

