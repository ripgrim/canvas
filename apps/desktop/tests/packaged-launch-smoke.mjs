import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[2]
assert.ok(mode === 'local' || mode === 'staging' || mode === 'production', 'Pass the packaged desktop mode to the smoke test.')

const executable = resolve(desktopRoot, 'release', mode, 'win-unpacked', 'Comp Canvas.exe')
await access(executable)

const result = await new Promise((resolveResult, reject) => {
  const child = spawn(executable, [], {
    env: { ...process.env, DESIGN_EDITOR_STARTUP_SMOKE: '1' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  child.once('error', reject)
  const timeout = setTimeout(() => {
    child.kill()
    reject(new Error(`The packaged main process did not finish its startup smoke test. ${output}`))
  }, 20_000)
  child.once('exit', (code, signal) => {
    clearTimeout(timeout)
    resolveResult({ code, signal, output })
  })
})

assert.equal(result.signal, null, result.output)
assert.equal(result.code, 0, result.output)
assert.doesNotMatch(result.output, /SyntaxError|Uncaught Exception|startup failed/i)
console.log(JSON.stringify({ status: 'passed', mode, executable: 'Comp Canvas.exe' }))
