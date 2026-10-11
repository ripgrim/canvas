import type { Atom } from './types.js'

const atom = (name: 'Button' | 'Card' | 'Input' | 'Label', props: Atom['props'], slots: string[]): Atom => ({
  componentId: `sample-${name.toLowerCase()}`,
  name,
  kind: 'atom',
  exportName: name,
  path: `Bundled sample / ${name}`,
  fingerprint: 'bundled-sample-v1',
  sourceHash: '',
  status: 'bound',
  candidates: [],
  props,
  slots,
})

const catalog: Atom[] = [
  atom('Button', [
    { name: 'children', type: 'ReactNode', optional: true },
    { name: 'variant', type: '"primary" | "quiet" | undefined', optional: true },
    { name: 'type', type: '"button" | "submit" | "reset" | undefined', optional: true },
    { name: 'disabled', type: 'boolean | undefined', optional: true },
  ], ['children']),
  atom('Card', [
    { name: 'children', type: 'ReactNode', optional: true },
    { name: 'heading', type: 'ReactNode', optional: true },
    { name: 'footer', type: 'ReactNode', optional: true },
    { name: 'id', type: 'string | undefined', optional: true },
  ], ['children', 'heading', 'footer']),
  atom('Input', [
    { name: 'id', type: 'string | undefined', optional: true },
    { name: 'name', type: 'string | undefined', optional: true },
    { name: 'type', type: 'HTMLInputTypeAttribute | undefined', optional: true },
    { name: 'placeholder', type: 'string | undefined', optional: true },
    { name: 'disabled', type: 'boolean | undefined', optional: true },
    { name: 'required', type: 'boolean | undefined', optional: true },
    { name: 'maxLength', type: 'number | undefined', optional: true },
  ], []),
  atom('Label', [
    { name: 'children', type: 'ReactNode', optional: true },
    { name: 'htmlFor', type: 'string | undefined', optional: true },
    { name: 'id', type: 'string | undefined', optional: true },
  ], ['children']),
]

/** The fixed browser catalog trusted by both clients and hosted collaboration rooms. */
export function hostedComponentCatalog(): Atom[] {
  return structuredClone(catalog)
}
