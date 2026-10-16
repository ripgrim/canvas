import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanShadcnRepository } from '../src/shadcn.js'
import { scanShadcnPreviewRegistry } from '../src/preview-registry.js'
import { verifyComponentRegistry } from '../../preview-runtime/src/verified-registry.mjs'

const temporary: string[] = []

async function fixture() {
  const base = path.join(process.cwd(), '.tmp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(path.join(base, 'design-editor-shadcn-'))
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
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'scanner-fixture', private: true, dependencies: { react: '19.3.0', 'react-dom': '19.3.0' } }), 'utf8')
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'scanner-fixture', lockfileVersion: 3, packages: { '': { dependencies: { react: '19.3.0', 'react-dom': '19.3.0' } }, 'node_modules/react': { version: '19.3.0' }, 'node_modules/react-dom': { version: '19.3.0' } } }), 'utf8')
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
      moduleConfig: { path: 'tsconfig.json', baseUrl: '.', paths: { '@/*': ['./src/*'] } },
      previewProvider: null,
      themeAdapters: [],
    })])
    expect(scan.components.map(({ path, exportName, packageName, declarationKind, slots }) => ({ path, exportName, packageName, declarationKind, slots }))).toEqual([
      { path: 'registry/default/ui/badge.tsx', exportName: 'Badge', packageName: 'scanner-fixture', declarationKind: 'function', slots: ['children'] },
      { path: 'src/components/ui/button.tsx', exportName: 'Button', packageName: 'scanner-fixture', declarationKind: 'variable', slots: ['children'] },
      { path: 'src/components/ui/dialog.tsx', exportName: 'Dialog', packageName: 'scanner-fixture', declarationKind: 'forwardRef', slots: ['children', 'trigger'] },
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
    expect(Object.keys(scan.sourceHashes)).toEqual(['package.json', 'registry/default/ui/badge.tsx', 'src/components/ui/button.tsx', 'src/components/ui/dialog.tsx', 'src/globals.css', 'tsconfig.json'])
  })

  it('does not execute repository scripts while scanning', async () => {
    const root = await fixture()
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { postinstall: 'node marker.js' } }), 'utf8')
    await writeFile(path.join(root, 'marker.js'), `require('node:fs').writeFileSync('executed', 'bad')`, 'utf8')

    const scan = await scanShadcnRepository(root)

    await expect(statOrNull(path.join(root, 'executed'))).resolves.toBeNull()
    expect(scan.components.every(component => component.packageName === null)).toBe(true)
  }, 30_000)

  it('[AT-SCAN-001] indexes module and export use-server directives as unsupported', async () => {
    const root = await fixture()
    await writeFile(path.join(root, 'src/components/ui/server-module.tsx'), `'use server'\nexport function ServerModule() { return <div>Server</div> }\n`, 'utf8')
    await writeFile(path.join(root, 'src/components/ui/server-action.tsx'), `export async function ServerAction() {\n  'use server'\n  return <div>Action</div>\n}\n`, 'utf8')

    const scan = await scanShadcnRepository(root)
    const generated = await scanShadcnPreviewRegistry(root)

    expect(scan.components.some(component => component.exportName === 'ServerModule')).toBe(false)
    expect(scan.components.some(component => component.exportName === 'ServerAction')).toBe(false)
    expect(generated.request.components.some(component => ['ServerModule', 'ServerAction'].includes(component.exportName))).toBe(false)
    expect(scan.diagnostics).toEqual(expect.arrayContaining([
      {
        code: 'unsupported-export',
        path: 'src/components/ui/server-module.tsx',
        message: 'ServerModule is server-only and cannot be indexed as a preview component.',
      },
      {
        code: 'unsupported-export',
        path: 'src/components/ui/server-action.tsx',
        message: 'ServerAction is server-only and cannot be indexed as a preview component.',
      },
    ]))
  })

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
      moduleConfig: { path: 'apps/web/tsconfig.json', baseUrl: 'apps/web', paths: { '#/*': ['./src/*'] } },
      previewProvider: null,
      themeAdapters: [],
    }])
    expect(scan.components.map(component => `${component.packageName}:${component.path}:${component.exportName}`)).toEqual(['@acme/web:apps/web/src/components/ui/button.tsx:Button'])
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
    expect(Object.keys(scan.sourceHashes)).toEqual(['apps/web/package.json', 'apps/web/src/components/ui/button.tsx', 'apps/web/src/styles.css', 'apps/web/tsconfig.json'])
  })

  it('[COMP-V2-ADMISSION-NEG-001][AT-SCAN-001] rejects ambiguous component owners', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'design-editor-ambiguous-owner-'))
    temporary.push(root)
    await mkdir(path.join(root, 'shared/ui'), { recursive: true })
    await writeFile(path.join(root, 'shared/ui/button.tsx'), 'export function Button() { return <button /> }\n', 'utf8')
    for (const workspace of ['apps/a', 'apps/b']) {
      await mkdir(path.join(root, workspace), { recursive: true })
      await writeFile(path.join(root, workspace, 'package.json'), JSON.stringify({ name: `@acme/${path.basename(workspace)}` }), 'utf8')
      await writeFile(path.join(root, workspace, 'components.json'), JSON.stringify({ aliases: { ui: '@ui' } }), 'utf8')
      await writeFile(path.join(root, workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@ui': ['../../shared/ui'] } } }), 'utf8')
    }

    await expect(scanShadcnRepository(root)).rejects.toThrow('Ambiguous component owner')
  })

  it('[AT-SCAN-001][AT-COMP-001] creates an integrity-bound registry without writing repository source bytes', async () => {
    const root = await fixture()
    const before = await repositoryBytes(root)

    const generated = await scanShadcnPreviewRegistry(root)
    const verified = await verifyComponentRegistry(root, generated.request)

    expect(verified.fingerprint).toMatch(/^sha256-/)
    expect(generated.request.components.map(component => component.exportName)).toEqual(['Badge', 'Button', 'Dialog'])
    expect(generated.request.components.find(component => component.exportName === 'Badge')).toEqual(expect.objectContaining({ props: {}, slots: ['children'] }))
    expect(generated.request.components.find(component => component.exportName === 'Button')).toEqual(expect.objectContaining({
      props: {
        disabled: { kind: 'boolean', optional: true },
        variant: { kind: 'enum', values: ['default', 'quiet'], optional: true },
      },
      slots: ['children'],
    }))
    expect(generated.request.components.find(component => component.exportName === 'Dialog')).toEqual(expect.objectContaining({ props: {}, slots: ['children', 'trigger'] }))
    expect(generated.request.styles).toEqual([expect.objectContaining({ path: 'src/globals.css', integrity: expect.stringMatching(/^sha256-/) })])
    expect(generated.request.aliases).toEqual([{
      configPath: 'tsconfig.json',
      integrity: expect.stringMatching(/^sha256-/),
      baseUrl: '.',
      paths: [{ pattern: '@/*', target: './src/*' }],
    }])
    expect(await repositoryBytes(root)).toEqual(before)
  })

  it('[AT-P0-001] invalidates the prior registry fingerprint when component source changes', async () => {
    const root = await fixture()
    const original = await scanShadcnPreviewRegistry(root)
    const prior = await verifyComponentRegistry(root, original.request)

    await writeFile(path.join(root, 'src/components/ui/button.tsx'), `export const Button = () => <button>Changed</button>\n`, 'utf8')

    await expect(verifyComponentRegistry(root, original.request)).rejects.toThrow('changed after the registry was generated')
    const refreshed = await scanShadcnPreviewRegistry(root)
    const current = await verifyComponentRegistry(root, refreshed.request)
    expect(current.fingerprint).not.toBe(prior.fingerprint)
  })

  it('[COMP-V2-CODE-010] pins the complete local import closure', async () => {
    const root = await fixture()
    await mkdir(path.join(root, 'src/lib'), { recursive: true })
    await mkdir(path.join(root, 'src/specific'), { recursive: true })
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'], '@/lib/*': ['./src/specific/*'] } } }), 'utf8')
    await writeFile(path.join(root, 'src/lib/label.ts'), `export const label = 'Wrong broad alias'\n`, 'utf8')
    await writeFile(path.join(root, 'src/specific/label.ts'), `export const label = 'Verified label'\n`, 'utf8')
    await writeFile(path.join(root, 'src/components/ui/button.tsx'), `import { label } from '@/lib/label'\nexport const Button = () => <button>{label}</button>\n`, 'utf8')

    const generated = await scanShadcnPreviewRegistry(root)

    expect(generated.request.dependencies).toContainEqual(expect.objectContaining({ path: 'src/specific/label.ts' }))
    expect(generated.request.dependencies).not.toContainEqual(expect.objectContaining({ path: 'src/lib/label.ts' }))
    expect(generated.request.resolutions).toContainEqual({ importer: 'src/components/ui/button.tsx', specifier: '@/lib/label', path: 'src/specific/label.ts' })
    expect(generated.scan.sourceHashes['src/specific/label.ts']).toMatch(/^[a-f0-9]{64}$/)
    await expect(verifyComponentRegistry(root, generated.request)).resolves.toMatchObject({
      dependencies: [expect.objectContaining({ path: 'src/specific/label.ts' })],
    })

    await writeFile(path.join(root, 'src/specific/label.ts'), `export const label = 'Changed label'\n`, 'utf8')
    await expect(verifyComponentRegistry(root, generated.request)).rejects.toThrow('changed after the registry was generated')
  })

  it('[COMP-V2-CODE-010] resolves overlapping aliases in the owning workspace', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'design-editor-scoped-aliases-'))
    temporary.push(root)
    for (const workspace of ['apps/web', 'packages/ui']) {
      await mkdir(path.join(root, workspace, 'src/components/ui'), { recursive: true })
      await writeFile(path.join(root, workspace, 'package.json'), JSON.stringify({ name: `@acme/${path.basename(workspace)}`, private: true }), 'utf8')
      await writeFile(path.join(root, workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }), 'utf8')
      await writeFile(path.join(root, workspace, 'src/styles.css'), ':root { --surface: #fff; }\n', 'utf8')
      await writeFile(path.join(root, workspace, 'src/label.ts'), `export const label = '${workspace}'\n`, 'utf8')
    }
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }), 'utf8')
    await writeFile(path.join(root, 'apps/web/src/components/ui/button.tsx'), `import { label } from '@/label'\nexport function Button() { return <button>{label}</button> }\n`, 'utf8')
    await writeFile(path.join(root, 'packages/ui/src/components/ui/card.tsx'), `import { label } from '@/label'\nexport function Card() { return <section>{label}</section> }\n`, 'utf8')

    const generated = await scanShadcnPreviewRegistry(root)

    expect(generated.request.resolutions).toEqual(expect.arrayContaining([
      { importer: 'apps/web/src/components/ui/button.tsx', specifier: '@/label', path: 'apps/web/src/label.ts' },
      { importer: 'packages/ui/src/components/ui/card.tsx', specifier: '@/label', path: 'packages/ui/src/label.ts' },
    ]))
    expect(generated.request.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'apps/web/src/label.ts' }),
      expect.objectContaining({ path: 'packages/ui/src/label.ts' }),
    ]))
  })

  it('[AT-COMP-001] reports unsupported component props instead of approximating them', async () => {
    const root = await fixture()
    await writeFile(path.join(root, 'src/components/ui/action.tsx'), `type ActionProps = { onAction(): void }\nexport function Action(_props: ActionProps) { return <button>Action</button> }\n`, 'utf8')
    await writeFile(path.join(root, 'src/components/ui/count.tsx'), `type CountProps = { count: number }\nexport function Count({ count }: CountProps) { return <span>{count}</span> }\n`, 'utf8')
    await writeFile(path.join(root, 'src/components/ui/level.tsx'), `type LevelProps = { level: 1 | 2 }\nexport function Level({ level }: LevelProps) { return <span>{level}</span> }\n`, 'utf8')
    await writeFile(path.join(root, 'src/components/ui/toggle.tsx'), `type ToggleProps = { state: true }\nexport function Toggle({ state }: ToggleProps) { return <span>{String(state)}</span> }\n`, 'utf8')

    const generated = await scanShadcnPreviewRegistry(root)

    expect(generated.request.components.map(component => component.exportName)).not.toEqual(expect.arrayContaining(['Action', 'Count', 'Level', 'Toggle']))
    expect(generated.scan.diagnostics).toEqual(expect.arrayContaining([
      { code: 'unsupported-preview-component', path: 'src/components/ui/action.tsx', message: 'Action has props that cannot be represented by the verified preview contract.' },
      { code: 'unsupported-preview-component', path: 'src/components/ui/count.tsx', message: 'Count has props that cannot be represented by the verified preview contract.' },
      { code: 'unsupported-preview-component', path: 'src/components/ui/level.tsx', message: 'Level has props that cannot be represented by the verified preview contract.' },
      { code: 'unsupported-preview-component', path: 'src/components/ui/toggle.tsx', message: 'Toggle has props that cannot be represented by the verified preview contract.' },
    ]))
  })

  it('[AT-PRV-001] carries provider and theme adapters only from explicit scanner configuration', async () => {
    const root = await fixture()
    await writeFile(path.join(root, 'components.json'), JSON.stringify({
      aliases: { ui: '@/components/ui' },
      tailwind: { css: 'src/globals.css' },
      designEditor: { preview: {
        provider: { entryPath: 'src/PreviewProvider.tsx', exportName: 'PreviewProvider', props: {} },
        themeAdapters: [{ entryPath: 'src/theme-adapter.ts', exportName: 'themeAdapter' }],
      } },
    }), 'utf8')
    await writeFile(path.join(root, 'src/PreviewProvider.tsx'), `export function PreviewProvider() { return null }\n`, 'utf8')
    await writeFile(path.join(root, 'src/theme-adapter.ts'), `export const themeAdapter = {}\n`, 'utf8')

    const generated = await scanShadcnPreviewRegistry(root)
    expect(generated.request.provider).toEqual(expect.objectContaining({
      entryPath: 'src/PreviewProvider.tsx',
      exportName: 'PreviewProvider',
      evidence: expect.objectContaining({ configPath: 'components.json' }),
    }))
    expect(generated.request.themeAdapters).toEqual([expect.objectContaining({
      entryPath: 'src/theme-adapter.ts',
      exportName: 'themeAdapter',
      evidence: expect.objectContaining({ configPath: 'components.json' }),
    })])
    await expect(verifyComponentRegistry(root, generated.request)).resolves.toMatchObject({
      provider: expect.objectContaining({ exportName: 'PreviewProvider' }),
      themeAdapters: [expect.objectContaining({ exportName: 'themeAdapter' })],
    })
  })
})

async function statOrNull(filename: string) {
  try { return await import('node:fs/promises').then(({ stat }) => stat(filename)) } catch { return null }
}

async function repositoryBytes(root: string, directory = ''): Promise<Record<string, string>> {
  const output: Record<string, string> = {}
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.posix.join(directory.replaceAll('\\', '/'), entry.name)
    if (entry.isDirectory()) Object.assign(output, await repositoryBytes(root, relative))
    else output[relative] = (await readFile(path.join(root, relative))).toString('base64')
  }
  return output
}
