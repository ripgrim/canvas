export const fixtureRegistry = [
  { componentId: 'fixture-login', exportName: 'PreviewLogin', entryPath: 'src/PreviewLogin.tsx', props: {}, slots: [] },
  { componentId: 'atom-card', exportName: 'Card', entryPath: 'src/atoms/Card.tsx', props: {}, slots: ['children', 'heading', 'footer'] },
  { componentId: 'atom-label', exportName: 'Label', entryPath: 'src/atoms/Label.tsx', props: { htmlFor: { kind: 'string' as const } }, slots: ['children'] },
  { componentId: 'atom-input', exportName: 'Input', entryPath: 'src/atoms/Input.tsx', props: { id: { kind: 'string' as const }, type: { kind: 'string' as const } }, slots: [] },
  { componentId: 'atom-button', exportName: 'Button', entryPath: 'src/atoms/Button.tsx', props: { type: { kind: 'string' as const }, variant: { kind: 'enum' as const, values: ['primary', 'quiet'] } }, slots: ['children'] },
] as const
