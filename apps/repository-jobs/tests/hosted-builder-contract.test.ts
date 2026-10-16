import { describe, expect, it } from 'vitest'
import { hostedPreviewDefaultProps } from '../../../infra/hosted-preview-builder/contract.mjs'

describe('hosted preview component prop contract', () => {
  it('COMP-V2-CODE-013 preserves optional component defaults', () => {
    expect(hostedPreviewDefaultProps({
      label: { kind: 'string', optional: false },
      count: { kind: 'number', optional: false },
      disabled: { kind: 'boolean', optional: true },
      tone: { kind: 'enum', values: ['neutral', 'danger'], optional: false },
      size: { kind: 'enum', values: ['small', 'large'], optional: true },
    })).toEqual({ label: 'label', count: 0, tone: 'neutral' })
  })

  it('rejects an incomplete or expanded prop rule', () => {
    expect(() => hostedPreviewDefaultProps({ label: { kind: 'string' } })).toThrow('Build contract is invalid.')
    expect(() => hostedPreviewDefaultProps({ label: { kind: 'string', optional: false, source: 'caller' } })).toThrow('Build contract is invalid.')
  })
})
