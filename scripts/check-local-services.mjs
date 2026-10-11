import { createServer } from 'node:net'
import { config as loadEnvironment } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localEnvironment, localServices, requiredLocalEnvironment } from './local-services.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
loadEnvironment({ path: resolve(root, '.env'), quiet: true })
loadEnvironment({ path: resolve(root, '.env.local'), quiet: true, override: true })
Object.assign(process.env, localEnvironment)

const missing = requiredLocalEnvironment.filter(name => !process.env[name]?.trim())
if (missing.length) fail(`Missing local environment: ${missing.join(', ')}`)

const ports = new Set()
for (const service of localServices) {
  if (ports.has(service.port)) fail(`Port ${service.port} is assigned more than once.`)
  ports.add(service.port)
  const url = new URL(service.readyUrl)
  if (Number(url.port) !== service.port) fail(`${service.label} readiness URL does not use port ${service.port}.`)
  if (url.hostname !== '127.0.0.1') fail(`${service.label} must bind to loopback in local development.`)
}

const occupied = []
for (const service of localServices) if (!(await portAvailable(service.port))) occupied.push(`${service.label} (${service.port})`)

process.stdout.write(`Local service topology is valid for ${localServices.length} services.\n`)
if (occupied.length) {
  process.stdout.write(`Already running: ${occupied.join(', ')}\n`)
} else {
  process.stdout.write('All service ports are available.\n')
}

function portAvailable(port) {
  return new Promise(resolveAvailability => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolveAvailability(false))
    server.listen({ host: '127.0.0.1', port }, () => server.close(() => resolveAvailability(true)))
  })
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

