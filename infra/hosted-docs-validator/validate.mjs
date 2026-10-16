import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, posix, resolve, sep } from 'node:path'

const sourceRoot = '/workspace'
const targetRoot = '/validator/repository'
const maximumInputBytes = 6 * 1024 * 1024
const maximumFiles = 500
const maximumFileBytes = 2 * 1024 * 1024
const maximumTotalBytes = 5 * 1024 * 1024
const pathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\u0000-\u001f\u007f]{1,512}$/u

const input = exact(await readInput(), ['files', 'changedPaths', 'profile'])
const files = record(input.files)
const changedPaths = list(input.changedPaths, maximumFiles).map(pathValue)
const profile = validationProfile(input.profile)
if (new Set(changedPaths).size !== changedPaths.length || Object.keys(files).length > maximumFiles) invalid('Documentation validation contract is invalid.')

let totalBytes = 0
const overlays = new Map()
for (const [rawPath, content] of Object.entries(files)) {
  const path = pathValue(rawPath)
  if (!path.startsWith('apps/docs/')) invalid('Documentation validation path is outside the docs app.')
  if (typeof content !== 'string') invalid('Documentation validation contract is invalid.')
  const bytes = new TextEncoder().encode(content)
  totalBytes += bytes.byteLength
  if (bytes.byteLength > maximumFileBytes || totalBytes > maximumTotalBytes || overlays.has(path)) invalid('Documentation validation contract is invalid.')
  overlays.set(path, content)
}
if (changedPaths.some(path => !overlays.has(path))) invalid('Documentation validation contract is invalid.')

await assertSafeTree(resolve(sourceRoot, 'apps/docs'))
await assertSafeTree(resolve(sourceRoot, 'packages/design-system'))
await assertSafeTree(resolve(sourceRoot, 'packages/tsconfig'))
await assertProfile(sourceRoot, profile)
if ((await readdir(targetRoot)).length !== 0) invalid('Documentation validation workspace is not empty.')
await mkdir(resolve(targetRoot, 'apps'), { recursive: true })
await mkdir(resolve(targetRoot, 'packages'), { recursive: true })
await cp(resolve(sourceRoot, 'package.json'), resolve(targetRoot, 'package.json'), { errorOnExist: true })
await cp(resolve(sourceRoot, 'bun.lock'), resolve(targetRoot, 'bun.lock'), { errorOnExist: true })
await copySourceDirectory(resolve(sourceRoot, 'apps/docs'), resolve(targetRoot, 'apps/docs'))
await copySourceDirectory(resolve(sourceRoot, 'packages/design-system'), resolve(targetRoot, 'packages/design-system'))
await copySourceDirectory(resolve(sourceRoot, 'packages/tsconfig'), resolve(targetRoot, 'packages/tsconfig'))
for (const [path, content] of overlays) {
  const target = resolve(targetRoot, ...path.split('/'))
  if (target !== targetRoot && !target.startsWith(`${targetRoot}${sep}`)) invalid('Documentation validation path is invalid.')
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
}

const docsRoot = resolve(targetRoot, 'apps/docs')
const docsInfo = await lstat(docsRoot)
if (!docsInfo.isDirectory()) invalid('Blume documentation app is missing.')
const cli = '/validator/node_modules/blume/bin/blume.mjs'
const check = await run('/usr/local/bin/bun', [cli, 'check', '--isolated', '--strict'], docsRoot)
if (check.code !== 0) invalid(`Blume documentation check failed with exit ${check.code}: ${bounded(check.stderr)}`)
await rm(resolve(docsRoot, '.blume-verify'), { recursive: true, force: true })
const build = await run('/usr/local/bin/bun', [cli, 'build', '--isolated', '--strict'], docsRoot)
if (build.code !== 0) invalid(`Blume documentation build failed with exit ${build.code}: ${bounded(build.stderr)}`)
process.stdout.write(JSON.stringify({ ok: true, profileId: profile.id, phases: ['check', 'build'] }))

async function assertSafeTree(root) {
  const canonicalRoot = await realpath(root)
  if (canonicalRoot !== root) invalid('Documentation source root is invalid.')
  await walk(root, root)
}

async function copySourceDirectory(source, target) {
  await cp(source, target, {
    recursive: true,
    errorOnExist: true,
    filter(path) {
      const relative = path === source ? '' : path.slice(source.length + 1).split(sep).join('/')
      return !excluded(relative)
    },
  })
}

async function assertProfile(root, profile) {
  for (const [path, expected] of Object.entries(profile.hashes)) {
    let content
    try { content = await readFile(resolve(root, ...path.split('/'))) }
    catch { invalid('Documentation validation profile does not match the source.') }
    if (createHash('sha256').update(content).digest('hex') !== expected) invalid('Documentation validation profile does not match the source.')
  }
}

async function walk(root, current) {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const path = resolve(current, entry.name)
    const relative = path.slice(root.length + 1).split(sep).join('/')
    if (excluded(relative)) continue
    if (entry.isSymbolicLink()) {
      await readlink(path)
      invalid('Documentation source contains a symbolic link.')
    }
    if (entry.isDirectory()) await walk(root, path)
    else if (!entry.isFile()) invalid('Documentation source contains an unsupported entry.')
  }
}

function excluded(relative) {
  return relative.split('/').some(part => ['.git', 'node_modules', '.design-editor', '.blume', '.blume-verify', '.next', '.turbo', 'dist', 'coverage'].includes(part) || part.startsWith('.env'))
}

function run(command, args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ASTRO_TELEMETRY_DISABLED: '1',
        CI: '1',
        HOME: '/tmp/home',
        NODE_ENV: 'production',
        PATH: '/validator/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let diagnostics = Buffer.alloc(0)
    const collect = chunk => {
      diagnostics = Buffer.concat([diagnostics, chunk]).subarray(-128 * 1024)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', rejectRun)
    child.once('close', code => resolveRun({ code: code ?? 1, stderr: diagnostics.toString('utf8') }))
  })
}

async function readInput() {
  const chunks = []
  let length = 0
  for await (const chunk of process.stdin) {
    length += chunk.byteLength
    if (length > maximumInputBytes) invalid('Documentation validation input is too large.')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { invalid('Documentation validation input is invalid.') }
}

function exact(value, keys) {
  const parsed = record(value)
  const actual = Object.keys(parsed)
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(parsed, key))) invalid('Documentation validation contract is invalid.')
  return parsed
}
function validationProfile(value) {
  const parsed = exact(value, ['id', 'hashes'])
  if (typeof parsed.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(parsed.id)) invalid('Documentation validation profile is invalid.')
  const hashes = exact(parsed.hashes, ['package.json', 'bun.lock', 'apps/docs/package.json', 'packages/design-system/package.json', 'packages/tsconfig/package.json', 'packages/tsconfig/base.json', 'packages/tsconfig/react-library.json'])
  for (const hash of Object.values(hashes)) if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) invalid('Documentation validation profile is invalid.')
  return Object.freeze({ id: parsed.id, hashes })
}
function record(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Documentation validation contract is invalid.'); return value }
function list(value, maximum) { if (!Array.isArray(value) || value.length > maximum) invalid('Documentation validation contract is invalid.'); return value }
function pathValue(value) { if (typeof value !== 'string' || !pathPattern.test(value) || posix.normalize(value) !== value) invalid('Documentation validation path is invalid.'); return value }
function bounded(value) {
  const clean = value.replace(/\u001b\[[0-9;]*m/gu, '').replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim()
  const marker = Math.max(clean.lastIndexOf('BLUME_BUILD_FAILED'), clean.lastIndexOf('[ERROR]'), clean.lastIndexOf('error:'))
  return (marker >= 0 ? clean.slice(marker, marker + 512) : clean.slice(-512)) || 'validator exited without diagnostics'
}
function invalid(message) { throw new Error(message) }
