import { describe, expect, it } from 'vitest'
import { displayDate } from './HomeScreen'

describe('AT-UX-003 recent-file dates', () => {
  const now = new Date('2026-10-09T20:00:00.000Z')

  it('uses short relative dates for recent edits and a calendar date for older edits', () => {
    expect(displayDate('2026-10-09T19:59:30.000Z', now)).toMatch(/30 seconds ago/)
    expect(displayDate('2026-10-09T19:33:00.000Z', now)).toMatch(/27 minutes ago/)
    expect(displayDate('2026-10-08T20:00:00.000Z', now)).toMatch(/yesterday|1 day ago/)
    expect(displayDate('2026-09-01T12:00:00.000Z', now)).not.toMatch(/ago/)
  })

  it('rejects missing and invalid dates', () => {
    expect(displayDate(undefined, now)).toBeUndefined()
    expect(displayDate('not-a-date', now)).toBeUndefined()
  })
})
