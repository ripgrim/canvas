import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanShadcnRepository } from '../src/shadcn.js'

const temporary: string[] = []

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'design-editor-shadcn-'))
  temporary.push(root)
  await mkdir(path.join(root, 'src/components/ui'), { recursive: true })
  await mkdir(path.join(root, 'registry/default/ui'), { recursive: true })
  await writeFile(path.join(root, 'components.json'), JSON.stringify({
    $schema: 'https://ui.shadcn.com/schema.json',
    tsx: true,
    aliases: { ui: '@/components/ui' },
    tailwind: { css: 'src/globals.css', cssVariables: true },
    registries: { '@acme': 'https://example.invalid/{name}.json' },
  }), 'utf8')
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }), 'utf8')
  await writeFile(path.join(root, 'src/components/ui/button.tsx'), `import type { ReactNode } from 'react'\nexport type ButtonProps = { children?: ReactNode; disabled?: boolean; variant?: 'default' | 'quiet' }\nexport const Button = ({ children }: ButtonProps) => <button>{children}</button>\nexport const buttonVariants = () => 'button'\n`, 'utf8')
  await writeFile(path.join(root, 'src/components/ui/dialog.tsx'), `import { forwardRef, type ReactNode } from 'react'\ntype DialogProps = { trigger?: ReactNode; children?: ReactNode }\nexport const Dialog = forwardRef<HTMLDivElement, DialogProps>(({ children }, ref) => <div ref={ref}>{children}</div>)\n`, 'utf8')
  await writeFile(path.join(root, 'registry/default/ui/badge.tsx'), `type BadgeProps = { children?: unknown }\nexport function Badge({ children }: BadgeProps) { return <span>{children}</span> }\n`, 'utf8')
  await writeFile(path.join(root, 'src/globals.css'), `@layer base {\n  :root { --background: oklch(1 0 0); --radius: 0.5rem; }\n  .dark { --background: oklch(0.2 0 0); }\n}\n@theme inline { --color-background: var(--background); }\n`, 'utf8')
  return root
}

afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

describe('shadcn repository scan', () => {
  it('discovers configured real TypeScript components and PostCSS token provenance', async () => {
    const scan = await scanShadcnRepository(await fixture())

    expect(scan.adapterId).toBe('shadcn-v1')
    expect(scan.configs).toEqual([expect.objectContaining({
      source: 'manifest',
      path: 'components.json',
      uiAlias: '@/components/ui',
      uiRoots: ['src/components/ui'],
      registryRoots: ['registry'],
      tokenFiles: ['src/globals.css'],
      registries: ['@acme'],
    })])
    expect(scan.components.map(({ path, exportName, declarationKind, slots }) => ({ path, exportName, declarationKind, slots }))).toEqual([
      { path: 'registry/default/ui/badge.tsx', exportName: 'Badge', declarationKind: 'function', slots: ['children'] },
      { path: 'src/components/ui/button.tsx', exportName: 'Button', declarationKind: 'variable', slots: ['children'] },
      { path: 'src/components/ui/dialog.tsx', exportName: 'Dialog', declarationKind: 'forwardRef', slots: ['children', 'trigger'] },
    ])
    expect(scan.tokens.map(({ name, theme, aliases, atRules }) => ({ name, theme, aliases, atRules }))).toEqual([
      { name: '--background', theme: 'base', aliases: [], atRules: ['@layer base'] },
      { name: '--radius', theme: 'base', aliases: [], atRules: ['@layer base'] },
      { name: '--background', theme: 'dark', aliases: [], atRules: ['@layer base'] },
      { name: '--color-background', theme: 'custom', aliases: ['--background'], atRules: ['@theme inline'] },
    ])
    expect(scan.diagnostics).toEqual([{
      code: 'unsupported-export',
      path: 'src/components/ui/button.tsx',
      message: 'buttonVariants is exported from the UI root but is not a supported React component declaration.',
    }])
    expect(Object.keys(scan.sourceHashes)).toEqual(['registry/default/ui/badge.tsx', 'src/components/ui/button.tsx', 'src/components/ui/dialog.tsx', 'src/globals.css'])
  })

  it('does not execute repository scripts while scanning', async () => {
    const root = await fixture()
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { postinstall: 'node marker.js' } }), 'utf8')
    await writeFile(path.join(root, 'marker.js'), `require('node:fs').writeFileSync('executed', 'bad')`, 'utf8')

    await scanShadcnRepository(root)

    await expect(statOrNull(path.join(root, 'executed'))).resolves.toBeNull()
  }, 30_000)

  it('infers a shadcn-style UI workspace and token stylesheet in a monorepo without components.json', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'design-editor-inferred-shadcn-'))
    temporary.push(root)
    await mkdir(path.join(root, 'apps/web/src/components/ui'), { recursive: true })
    await mkdir(path.join(root, 'apps/web/src/components/account'), { recursive: true })
    await mkdir(path.join(root, 'packages/ui/src'), { recursive: true })
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }), 'utf8')
    await writeFile(path.join(root, 'apps/web/package.json'), JSON.stringify({ name: '@acme/web', private: true }), 'utf8')
    await writeFile(path.join(root, 'apps/web/tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '#/*': ['./src/*'] } } }), 'utf8')
    await writeFile(path.join(root, 'apps/web/src/components/ui/button.tsx'), `type ButtonProps = { children?: unknown; variant?: 'default' | 'quiet' }
function Button({ children }: ButtonProps) { return <button>{children}</button> }
const buttonVariants = () => 'button'
export { Button, buttonVariants }
`, 'utf8')
    await writeFile(path.join(root, 'apps/web/src/components/account/profile.tsx'), `export function Profile() { return <main>Profile</main> }
`, 'utf8')
    await writeFile(path.join(root, 'apps/web/src/styles.css'), `:root { --background: oklch(1 0 0); --radius: 0.625rem; }
.dark { --background: #0d0d0d; }
@theme inline { --color-background: var(--background); }
`, 'utf8')
    await writeFile(path.join(root, 'packages/ui/package.json'), JSON.stringify({ name: '@acme/ui', private: true }), 'utf8')
    await writeFile(path.join(root, 'packages/ui/src/index.ts'), 'export {}\n', 'utf8')

    const scan = await scanShadcnRepository(root)

    expect(scan.configs).toEqual([{
      source: 'inferred',
      path: 'apps/web/package.json',
      workspace: 'apps/web',
      uiAlias: null,
      uiRoots: ['apps/web/src/components/ui'],
      registryRoots: [],
      tokenFiles: ['apps/web/src/styles.css'],
      registries: [],
    }])
    expect(scan.components.map(component => `${component.path}:${component.exportName}`)).toEqual(['apps/web/src/components/ui/button.tsx:Button'])
    expect(scan.tokens.map(({ name, theme }) => ({ name, theme }))).toEqual([
      { name: '--background', theme: 'base' },
      { name: '--radius', theme: 'base' },
      { name: '--background', theme: 'dark' },
      { name: '--color-background', theme: 'custom' },
    ])
    expect(scan.diagnostics).toEqual([{
      code: 'unsupported-export',
      path: 'apps/web/src/components/ui/button.tsx',
      message: 'buttonVariants is exported from the UI root but is not a supported React component declaration.',
    }])
    expect(Object.keys(scan.sourceHashes)).toEqual(['apps/web/src/components/ui/button.tsx', 'apps/web/src/styles.css'])
  })
})

async function statOrNull(filename: string) {
  try { return await import('node:fs/promises').then(({ stat }) => stat(filename)) } catch { return null }
}
