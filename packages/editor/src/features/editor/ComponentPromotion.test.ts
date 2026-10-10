import { describe, expect, it } from 'vitest'
import type { EditorState } from './store'
import { componentPromotionAvailability } from './ComponentPromotion'

const available = { available: true, reason: 'Granted for test' } as const
const state = (patch: Partial<Pick<EditorState, 'busy' | 'capabilities' | 'componentName' | 'snapshot'>> = {}) => ({
  busy: null, componentName: 'LoginForm', snapshot: { conflict: null },
  capabilities: { sourceWrites: available }, ...patch,
} as unknown as Pick<EditorState, 'busy' | 'capabilities' | 'componentName' | 'snapshot'>)

describe('component promotion availability', () => {
  it('keeps repository promotion enabled only after the local document is saved', () => {
    expect(componentPromotionAvailability(state(), { dirty: false, saving: false })).toEqual({ disabled: false, reason: null })
    expect(componentPromotionAvailability(state(), { dirty: true, saving: false })).toMatchObject({ disabled: true, reason: expect.stringContaining('Save') })
  })

  it('shows the capability reason instead of implying source creation succeeded', () => {
    const current = state({ capabilities: { sourceWrites: { available: false, reason: 'Read-only fixture' } } as EditorState['capabilities'] })
    expect(componentPromotionAvailability(current, { dirty: false, saving: false })).toEqual({ disabled: true, reason: 'Read-only fixture' })
  })
})
