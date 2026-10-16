import { describe, expect, it } from 'vitest'
import { admitCodeComponent, codeComponentPropertiesFromScan, codeComponentValueId, rebindCodeComponent, validateCodeComponentBinding, verifiedCodeComponentFromCatalog } from '../src/component-admission.js'

const sourceHash = 'a'.repeat(64)
const registryFingerprint = `sha256:${'b'.repeat(64)}`
const access = { provider: 'github' as const, projectId: 'project-1', repositoryId: '4001' }
const binding = {
  id: 'binding:button',
  access,
  adapterId: 'shadcn-v1',
  path: 'src/components/ui/button.tsx',
  exportName: 'Button',
  sourceHash,
  registryFingerprint,
}
const component = {
  componentId: 'shadcn:Button:1234567890abcdef',
  path: binding.path,
  exportName: binding.exportName,
  sourceHash,
  registryFingerprint,
  props: {
    label: { kind: 'string' as const, optional: false },
    disabled: { kind: 'boolean' as const, optional: false },
    variant: { kind: 'enum' as const, values: ['quiet', 'solid'], optional: false },
    tone: { kind: 'enum' as const, values: ['neutral', 'danger'], optional: true },
  },
  slots: ['children'],
}

describe('code component admission', () => {
  it('[COMP-V2-ADMISSION-002] projects scanner props through the same representable property contract', () => {
    expect(codeComponentPropertiesFromScan([
      { name: 'label', type: 'string', optional: false },
      { name: 'description', type: 'string | undefined', optional: true },
      { name: 'active', type: 'boolean', optional: true },
      { name: 'tone', type: "'quiet' | 'solid'", optional: true },
      { name: 'count', type: 'number', optional: false },
      { name: 'children', type: 'ReactNode', optional: true },
    ], ['children'])).toEqual([
      { id: 'property:label', name: 'label', type: 'text', defaultValue: '' },
      { id: 'property:description', name: 'description', type: 'text', defaultValue: '', optional: true },
      { id: 'property:active', name: 'active', type: 'boolean', defaultValue: false, optional: true },
      {
        id: 'property:tone',
        name: 'tone',
        type: 'variant',
        defaultValueId: codeComponentValueId('quiet'),
        values: [
          { id: codeComponentValueId('quiet'), name: 'quiet' },
          { id: codeComponentValueId('solid'), name: 'solid' },
        ],
        optional: true,
      },
      { id: 'property:children', name: 'children', type: 'slot', optional: true },
    ])
  })

  it('[COMP-V2-ADMISSION-003] converts an integrity-bound catalog entry into exact admission evidence', () => {
    expect(verifiedCodeComponentFromCatalog(`sha256-${'A'.repeat(43)}=`, {
      componentId: component.componentId,
      path: component.path,
      exportName: component.exportName,
      sourceHash,
      props: [
        { name: 'label', type: 'string', optional: false },
        { name: 'tone', type: "'neutral' | 'danger' | undefined", optional: true },
        { name: 'children', type: 'ReactNode', optional: true },
      ],
      slots: ['children'],
    })).toMatchObject({
      componentId: component.componentId,
      registryFingerprint: `sha256-${'A'.repeat(43)}=`,
      props: {
        label: { kind: 'string', optional: false },
        tone: { kind: 'enum', values: ['neutral', 'danger'], optional: true },
      },
      slots: ['children'],
    })
    expect(() => verifiedCodeComponentFromCatalog('github:revision', {
      componentId: component.componentId,
      path: component.path,
      exportName: component.exportName,
      sourceHash,
      props: [],
      slots: [],
    })).toThrow('registry fingerprint')
  })

  it('[COMP-V2-ADMISSION-001] admits exact GitHub-backed scanner evidence into the unified component model', () => {
    const admitted = admitCodeComponent({
      componentId: 'component:button',
      binding,
      component,
      defaults: { label: 'Continue', disabled: false, variant: 'solid' },
      docs: { slug: 'button', description: 'Triggers an action.' },
    })
    expect(admitted.binding).toEqual(binding)
    expect(admitted.definition).toMatchObject({
      id: 'component:button',
      name: 'Button',
      source: { kind: 'code', bindingId: 'binding:button' },
      revision: 0,
      docs: { slug: 'button' },
    })
    expect(admitted.definition.properties.map(property => ({ id: property.id, type: property.type, optional: property.optional ?? false }))).toEqual([
      { id: 'property:label', type: 'text', optional: false },
      { id: 'property:disabled', type: 'boolean', optional: false },
      { id: 'property:variant', type: 'variant', optional: false },
      { id: 'property:tone', type: 'variant', optional: true },
      { id: 'property:children', type: 'slot', optional: true },
    ])
  })

  it('[COMP-V2-ADMISSION-NEG-001] rejects stale evidence, invented defaults, numeric props, and injected grant fields', () => {
    expect(() => admitCodeComponent({ componentId: 'component:button', binding, component: { ...component, sourceHash: 'c'.repeat(64) }, defaults: { label: 'Continue', disabled: false, variant: 'solid' } })).toThrow('evidence changed')
    expect(() => admitCodeComponent({ componentId: 'component:button', binding, component, defaults: { label: 'Continue', disabled: false, variant: 'missing' } })).toThrow('cannot be represented')
    expect(() => admitCodeComponent({ componentId: 'component:button', binding, component: { ...component, props: { count: { kind: 'number', optional: false } } }, defaults: { count: '1' } })).toThrow('Numeric component props')
    expect(() => admitCodeComponent({ componentId: 'component:button', binding, component, defaults: { label: 'Continue', disabled: false, variant: 'solid', tone: 'neutral' } })).toThrow('defaults do not match')
    expect(() => admitCodeComponent({ componentId: 'component:button', binding, component, defaults: { label: 'Continue', disabled: false, variant: 'solid' }, injected: true } as never)).toThrow('Invalid code component admission')
    expect(() => validateCodeComponentBinding({ ...binding, access: { ...access, installationId: '2001' } })).toThrow('Invalid component repository access')
  })

  it('[COMP-V2-BINDING-001] preserves binding identity across a checked source move or export rename', () => {
    const moved = {
      ...component,
      componentId: 'shadcn:PrimaryButton:fedcba0987654321',
      path: 'src/components/actions/primary-button.tsx',
      exportName: 'PrimaryButton',
      sourceHash: 'c'.repeat(64),
      registryFingerprint: `sha256:${'d'.repeat(64)}`,
    }
    expect(rebindCodeComponent(binding, component, moved)).toEqual({
      ...binding,
      path: moved.path,
      exportName: moved.exportName,
      sourceHash: moved.sourceHash,
      registryFingerprint: moved.registryFingerprint,
    })
    expect(() => rebindCodeComponent(binding, { ...component, sourceHash: 'e'.repeat(64) }, moved)).toThrow('evidence changed')
  })
})
