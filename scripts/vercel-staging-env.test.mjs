import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = resolve(root, 'scripts/vercel-staging-env.mjs')
const template = readFileSync(resolve(root, '.env.staging.example'), 'utf8')

test('validates a complete staging environment without exposing values', () => {
  const secret = 'test-secret-that-must-not-appear'
  const result = run(filledTemplate(secret))
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Validated \d+ branch-scoped variables without uploading them\./)
  assert.match(result.stdout, /"branch":"staging"/)
  assert.doesNotMatch(result.stdout, new RegExp(secret))
})

test('rejects a missing staging secret', () => {
  const result = run(filledTemplate('filled').replace('DATABASE_URL="filled"', 'DATABASE_URL=""'))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Staging environment is incomplete: DATABASE_URL/)
})

test('rejects a production origin in the staging environment', () => {
  const result = run(filledTemplate('filled').replace('VITE_API_ORIGIN="https://staging.canvas.ripgrim.com"', 'VITE_API_ORIGIN="https://api.canvas.ripgrim.com"'))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /VITE_API_ORIGIN points at a production origin/)
})

test('rejects a shared parent-domain auth cookie', () => {
  const result = run(filledTemplate('filled').replace('AUTH_COOKIE_DOMAIN=""', 'AUTH_COOKIE_DOMAIN="canvas.ripgrim.com"'))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /AUTH_COOKIE_DOMAIN must stay empty/)
})

test('rejects a staging cookie prefix that can collide with production', () => {
  const result = run(filledTemplate('filled').replace('AUTH_COOKIE_PREFIX="comp-canvas-staging"', 'AUTH_COOKIE_PREFIX="better-auth"'))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /AUTH_COOKIE_PREFIX must be comp-canvas-staging/)
})

function filledTemplate(value) {
  return template.replaceAll('=""', `="${value}"`).replace(`AUTH_COOKIE_DOMAIN="${value}"`, 'AUTH_COOKIE_DOMAIN=""')
}

function run(source) {
  const directory = mkdtempSync(resolve(tmpdir(), 'canvas-staging-env-'))
  const path = resolve(directory, '.env.staging')
  try {
    writeFileSync(path, source, 'utf8')
    return spawnSync(process.execPath, [script, '--env-file', path], { cwd: root, encoding: 'utf8' })
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
}
