import assert from 'node:assert/strict'
import test from 'node:test'
import { processErrorDecision, processExitDecision } from './dev-process-lifecycle.mjs'

test('AT-AUTH-001 keeps cloud auth running when the desktop shell closes', () => {
  assert.deepEqual(processExitDecision('desktop-shell', 0), { stopStack: false, exitCode: 0 })
  assert.deepEqual(processExitDecision('desktop-shell', 1), { stopStack: false, exitCode: 1 })
  assert.deepEqual(processErrorDecision('desktop-shell'), { stopStack: false, exitCode: 1 })
})

test('AT-AUTH-001 stops a partial stack when a required service exits', () => {
  assert.deepEqual(processExitDecision('required-service', 0), { stopStack: true, exitCode: 0 })
  assert.deepEqual(processExitDecision('required-service', 1), { stopStack: true, exitCode: 1 })
  assert.deepEqual(processExitDecision('required-service', null), { stopStack: true, exitCode: 1 })
  assert.deepEqual(processErrorDecision('required-service'), { stopStack: true, exitCode: 1 })
})

test('unknown process kinds fail closed', () => {
  assert.throws(() => processExitDecision('optional-worker', 0), /Unknown development process kind/)
  assert.throws(() => processErrorDecision('optional-worker'), /Unknown development process kind/)
})
