import { describe, expect, it } from 'vitest'
import { componentCatalogFromShadcnScan } from '../src/component-catalog.js'

const sourceHash = 'a'.repeat(64)
const scan = { components: [{ path: 'src/button.tsx', exportName: 'Button', sourceHash, props: [{ name: 'tone', type: "'quiet' | 'solid'", optional: false }, { name: 'children', type: 'ReactNode', optional: true }], slots: ['children'] }] }
const request = { components: [{ componentId: 'shadcn:Button:1234567890abcdef', entryPath: 'src/button.tsx', exportName: 'Button', props: { tone: { kind: 'enum', values: ['quiet', 'solid'] } }, slots: ['children'] }] }

describe('component catalog', () => {
  it('derives the exact verified component schema without repository source', () => {
    expect(componentCatalogFromShadcnScan(scan, request, 'github:revision')).toEqual({
      fingerprint: 'github:revision',
      components: [{ componentId: 'shadcn:Button:1234567890abcdef', path: 'src/button.tsx', exportName: 'Button', sourceHash, props: scan.components[0]!.props, slots: ['children'] }],
    })
  })

  it('rejects registry entries that do not match the immutable scan', () => {
    expect(() => componentCatalogFromShadcnScan(scan, { components: [{ ...request.components[0], entryPath: 'src/card.tsx' }] }, 'github:revision')).toThrow('missing')
    expect(() => componentCatalogFromShadcnScan(scan, { components: [{ ...request.components[0], props: { missing: { kind: 'string' } } }] }, 'github:revision')).toThrow('schema')
  })
})
