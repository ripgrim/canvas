import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'dotenv'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pnpm = process.env.npm_execpath
if (!pnpm) throw new Error('Run this command through pnpm dev:sync-github-app.')

const names = Object.freeze([
  'GITHUB_APP_ID',
  'GITHUB_APP_SLUG',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_WEBHOOK_SECRET',
  'GITHUB_APP_CREDENTIAL_ENCRYPTION_KEY',
])
const directory = await mkdtemp(resolve(tmpdir(), 'canvas-github-app-'))
const pulledPath = resolve(directory, 'preview.env')

try {
  const result = spawnSync(process.execPath, [pnpm, 'exec', 'vercel', 'env', 'pull', pulledPath, '--environment=preview', '--git-branch=staging', '--yes'], {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('Could not download the staging GitHub App configuration.')
  const lines = (await readFile(pulledPath, 'utf8')).split(/\r?\n/)
  const selected = lines.filter(line => names.includes(line.slice(0, line.indexOf('='))))
  const present = new Set(selected.map(line => line.slice(0, line.indexOf('='))))
  const missing = names.filter(name => !present.has(name))
  if (missing.length) throw new Error(`Missing staging GitHub App configuration: ${missing.join(', ')}`)
  const values = parse(selected.join('\n'))
  if (!/^[1-9][0-9]{0,31}$/.test(values.GITHUB_APP_ID ?? '') || selected.some(line => line.endsWith('="[Encrypted]"'))) {
    throw new Error('The staging GitHub App configuration contains placeholder values. Replace them in Vercel before syncing local development.')
  }
  await writeFile(resolve(root, '.env.github-preview'), `${selected.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  process.stdout.write('Local staging GitHub App configuration is ready.\n')
} finally {
  await rm(directory, { recursive: true, force: true })
}
