import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { checkSource } from '../scripts/check-contracts.mjs'

const fixtures = new URL('./fixtures/', import.meta.url)

async function fixture(name: string) {
  return readFile(new URL(name, fixtures), 'utf8')
}

describe('AT-CODE-002 authored lifecycle rules', () => {
  const invalid = [
    ['effect-direct.tsx', 'prohibited lifecycle call'],
    ['effect-alias.tsx', 'prohibited lifecycle call'],
    ['effect-namespace.tsx', 'prohibited lifecycle member'],
    ['effect-reexport.ts', 'prohibited lifecycle re-export'],
    ['effect-wrapper.tsx', 'prohibited lifecycle call'],
    ['effect-alternates.tsx', 'prohibited lifecycle call'],
    ['effect-destructure.tsx', 'prohibited lifecycle alias'],
    ['lifecycle-class.tsx', 'prohibited class lifecycle'],
    ['render-side-effect.tsx', 'render-time side effect'],
  ] as const

  for (const [name, reason] of invalid) {
    it(`rejects ${name}`, async () => {
      expect(checkSource(await fixture(name), `apps/desktop/src/renderer/features/${name}`).join('\n')).toContain(reason)
    })
  }

  it('resolves an aliased call, beyond recognizing its import', async () => {
    const source = await fixture('effect-alias.tsx')
    const diagnostics = checkSource(source, 'apps/desktop/src/renderer/features/Panel.tsx')
    expect(diagnostics.some(item => item.includes('prohibited lifecycle call'))).toBe(true)
    const safeMutation = source.replace('afterRender(() => {}, [])', 'runCommand()')
    expect(checkSource(safeMutation, 'apps/desktop/src/renderer/features/Panel.tsx').some(item => item.includes('prohibited lifecycle call'))).toBe(false)
  })

  it('detects a render mutation while allowing an event command', async () => {
    const source = await fixture('render-side-effect.tsx')
    expect(checkSource(source, 'apps/desktop/src/renderer/features/Panel.tsx').some(item => item.includes('render-time side effect'))).toBe(true)
    expect(checkSource(source.replace("window.localStorage.setItem('key', 'value')", 'const value = 1'), 'apps/desktop/src/renderer/features/Panel.tsx').some(item => item.includes('render-time side effect'))).toBe(false)
    expect(checkSource(await fixture('valid-event.tsx'), 'apps/desktop/src/renderer/features/Panel.tsx')).toEqual([])
  })

  it('allows a stable external store adapter', async () => {
    expect(checkSource(await fixture('valid-store.tsx'), 'apps/desktop/src/renderer/features/Panel.tsx')).toEqual([])
  })

  it('rejects a wildcard re-export of React hooks', () => {
    expect(checkSource("export * from 'react'", 'apps/desktop/src/renderer/features/hooks.ts').join('\n')).toContain('prohibited lifecycle wildcard re-export')
  })

  it('rejects lifecycle properties and work done by a class render method', () => {
    const source = "class Panel extends React.Component { componentDidMount = () => {}; render() { fetch('/data'); return <Widget /> } }"
    const diagnostics = checkSource(source, 'apps/desktop/src/renderer/features/Panel.tsx').join('\n')
    expect(diagnostics).toContain('prohibited class lifecycle')
    expect(diagnostics).toContain('render-time side effect')
  })
})

describe('AT-CODE-001 page composition', () => {
  const invalid = [
    ['page-raw.tsx', 'page contains raw DOM'],
    ['page-copy.tsx', 'page contains inline copy'],
    ['page-feature.tsx', 'page contains feature implementation'],
  ] as const

  for (const [name, reason] of invalid) {
    it(`rejects ${name}`, async () => {
      expect(checkSource(await fixture(name), `apps/desktop/src/renderer/pages/${name}`).join('\n')).toContain(reason)
    })
  }

  it('allows named composition and a TanStack route declaration', async () => {
    expect(checkSource(await fixture('page-valid.tsx'), 'apps/desktop/src/renderer/pages/Login.tsx')).toEqual([])
    expect(checkSource(await fixture('route-valid.tsx'), 'apps/web/src/routes/login.tsx')).toEqual([])
  })

  it('limits the document exception to the root route and exact shell', async () => {
    const valid = await fixture('document-valid.tsx')
    expect(checkSource(valid, 'apps/web/src/routes/__root.tsx')).toEqual([])
    expect(checkSource(valid, 'apps/web/src/routes/login.tsx').length).toBeGreaterThan(0)
    expect(checkSource(await fixture('document-invalid.tsx'), 'apps/web/src/routes/__root.tsx').join('\n')).toContain('invalid document shell')
    expect(checkSource(valid + '\nexport function Sneak() { return <head /> }', 'apps/web/src/routes/__root.tsx').join('\n')).toContain('page contains raw DOM')
  })
})
