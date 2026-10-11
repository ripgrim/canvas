import assert from 'node:assert/strict'
import test from 'node:test'
import { findHiddenErrorsInSource } from './check-hidden-errors.mjs'

test('ERROR-VISIBILITY-001 rejects empty catch clauses and discarded promise failures', () => {
  const failures = findHiddenErrorsInSource('fixture.ts', `
    async function hidden(work: Promise<void>) {
      try { await work } catch {}
      await work.catch(() => undefined)
      await work.catch(() => {})
      await work.catch(() => { return undefined })
    }
  `)
  assert.equal(failures.filter(value => value.includes('empty catch clause')).length, 1)
  assert.equal(failures.filter(value => value.includes('rejected promise is discarded')).length, 3)
})

test('ERROR-VISIBILITY-001 accepts failures that are surfaced, transformed, or reported', () => {
  const failures = findHiddenErrorsInSource('fixture.ts', `
    async function visible(work: Promise<void>) {
      try { await work } catch (error) { throw new Error('Work failed', { cause: error }) }
      await work.catch(error => console.error(error))
      try { JSON.parse('') } catch { return null }
    }
  `)
  assert.deepEqual(failures, [])
})
