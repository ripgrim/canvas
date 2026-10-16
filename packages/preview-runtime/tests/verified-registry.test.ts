import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { build } from 'vite'
import { loadVerifiedRegistryManifest, registryRequestFromPreviewBinding, verifyComponentRegistry } from '../src/verified-registry.mjs'
import { verifiedModuleBoundaryPlugin, verifiedRegistryPlugin } from '../src/verified-registry-plugin.mjs'
import { sourceBindingPlugin } from '../src/source-binding-plugin.mjs'

const repositoryRoot = resolve(import.meta.dirname, 'fixtures/verified-repo')
const component = <T extends Readonly<{ componentId: string; entryPath: string; exportName: string }>>(value: T) => ({ props: {} as const, slots: [] as const, ...value })
const reactDependencies = { react: '19.3.0', 'react-dom': '19.3.0' } as const

async function writeReactPackageContract(root: string) {
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, type: 'module', dependencies: reactDependencies }))
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({
    name: 'fixture',
    lockfileVersion: 3,
    packages: {
      '': { dependencies: reactDependencies },
      'node_modules/react': { version: '19.3.0' },
      'node_modules/react-dom': { version: '19.3.0' },
    },
  }))
}

const request = {
  version: 1,
  entry: { componentId: 'verified-alert' },
  components: [{ componentId: 'verified-alert', entryPath: 'src/AlertPanel.tsx', exportName: 'AlertPanel', props: { tone: { kind: 'enum', values: ['calm', 'urgent'] } }, slots: ['children'] }],
  styles: [{ path: 'src/styles.css' }],
  provider: { entryPath: 'src/PreviewProvider.tsx', exportName: 'PreviewProvider', props: {}, evidence: { configPath: 'components.json' } },
  themeAdapters: [{ entryPath: 'src/theme-adapter.ts', exportName: 'themeAdapter', evidence: { configPath: 'components.json' } }],
  assets: [
    { assetId: 'fixture-mark', sourcePath: 'public/mark.svg', publicPath: '/registry-assets/mark.svg', mime: 'image/svg+xml' },
    { assetId: 'fixture-font', sourcePath: 'public/fixture.woff2', publicPath: '/registry-assets/fixture.woff2', mime: 'font/woff2' },
  ],
  fonts: [{ family: 'Registry fixture', assetId: 'fixture-font', weight: '400', style: 'normal', display: 'swap' }],
} as const

describe('AT-P0-001, AT-SCAN-001, AT-COMP-001, and AT-PRV-001 verified component registry', () => {
  it('binds exact exports, styles, provider, theme adapter, fonts, and assets from a checked-in repository', async () => {
    const registry = await verifyComponentRegistry(repositoryRoot, request)
    expect(registry.entry.exportName).toBe('AlertPanel')
    expect(registry.components.map(component => component.componentId)).toEqual(['verified-alert'])
    expect(registry.styles[0]?.path).toBe('src/styles.css')
    expect(registry.provider?.exportName).toBe('PreviewProvider')
    expect(registry.themeAdapters[0]?.exportName).toBe('themeAdapter')
    expect(registry.assets.map(asset => asset.publicPath)).toEqual(['/registry-assets/mark.svg', '/registry-assets/fixture.woff2'])
    expect(registry.fonts).toEqual([{ family: 'Registry fixture', assetId: 'fixture-font', weight: '400', style: 'normal', display: 'swap' }])
    expect(registry.components[0]?.props).toEqual({ tone: { kind: 'enum', values: ['calm', 'urgent'] } })
    expect(registry.components[0]?.slots).toEqual(['children'])
    expect(registry.fingerprint).toMatch(/^sha256-/)

    const pinned: { [key: string]: any } = structuredClone(request)
    pinned.components[0] = { ...pinned.components[0], integrity: registry.components[0]!.integrity }
    await expect(verifyComponentRegistry(repositoryRoot, pinned)).resolves.toMatchObject({ fingerprint: registry.fingerprint })
    pinned.components[0] = { ...pinned.components[0], integrity: 'sha256-stale' }
    await expect(verifyComponentRegistry(repositoryRoot, pinned)).rejects.toThrow('changed after the registry was generated')
  })

  it('[AT-SCAN-001] rejects component contracts that omit explicit props or slots', async () => {
    const { props: _props, ...withoutProps } = request.components[0]
    const { slots: _slots, ...withoutSlots } = request.components[0]

    await expect(verifyComponentRegistry(repositoryRoot, { ...request, components: [withoutProps] } as never)).rejects.toThrow('Invalid or duplicate component binding')
    await expect(verifyComponentRegistry(repositoryRoot, { ...request, components: [withoutSlots] } as never)).rejects.toThrow('Invalid or duplicate component binding')
  })

  it('[AT-SCAN-001] rejects malformed prop optionality evidence', async () => {
    await expect(verifyComponentRegistry(repositoryRoot, {
      ...request,
      components: [{ ...request.components[0], props: { tone: { ...request.components[0].props.tone, optional: 'yes' } } }],
    } as never)).rejects.toThrow('Invalid component prop rule')
  })

  it('[AT-SCAN-001] requires explicit selected-component schema when adapting a preview binding', () => {
    const selected = { componentId: 'panel', entryPath: 'Panel.tsx', exportName: 'Panel' }
    expect(() => registryRequestFromPreviewBinding({ ...selected, registry: [selected] })).toThrow('needs explicit props and slots')
    expect(registryRequestFromPreviewBinding({ ...selected, registry: [{ ...selected, props: {}, slots: [] }] }).components).toEqual([
      { ...selected, props: {}, slots: [] },
    ])
  })

  it('[AT-SCAN-001] includes explicit props and slots in the contract fingerprint', async () => {
    const detailed = await verifyComponentRegistry(repositoryRoot, request)
    const empty = await verifyComponentRegistry(repositoryRoot, {
      ...request,
      components: [{ ...request.components[0], props: {}, slots: [] }],
    })

    expect(empty.fingerprint).not.toBe(detailed.fingerprint)
    expect(empty.components[0]?.props).toEqual({})
    expect(empty.components[0]?.slots).toEqual([])
  })

  it('supports verified const exports without a component-name allowlist', async () => {
    const registry = await verifyComponentRegistry(repositoryRoot, request)
    const plugin = sourceBindingPlugin(registry.components.map(component => ({ componentId: component.componentId, exportName: component.exportName, entryPath: component.absolutePath })), '/runtime/source-bindings.mjs')
    const source = await readFile(join(repositoryRoot, 'src/AlertPanel.tsx'), 'utf8')
    const transformed = plugin.transform(source, registry.components[0]!.absolutePath)
    expect(transformed?.code).toContain('__DesignEditorBind("verified-alert", "AlertPanel", AlertPanel)')
    expect(transformed?.code).toContain('export { __DesignEditorBound_AlertPanel as AlertPanel }')
    expect(transformed?.code).not.toContain('sample-button')
  })

  it('preserves unrelated exports when binding one declaration from a multi-declarator statement', () => {
    const source = `export const Before = 'before', AlertPanel = () => 'panel', After = AlertPanel() + '-after'\n`
    const moduleId = resolve(repositoryRoot, 'src/MultiExport.tsx')
    const plugin = sourceBindingPlugin([{ componentId: 'verified-alert', exportName: 'AlertPanel', entryPath: moduleId }], '/runtime/source-bindings.mjs')
    const transformed = plugin.transform(source, moduleId)
    expect(transformed?.code).toContain("export const Before = 'before';")
    expect(transformed?.code).toContain("const AlertPanel = () => 'panel';")
    expect(transformed?.code).toContain("export const After = AlertPanel() + '-after';")
    expect(transformed?.code).toContain('export { __DesignEditorBound_AlertPanel as AlertPanel }')
  })

  it('generates one browser registry module and emits declared font and image assets', async () => {
    const registry = await loadVerifiedRegistryManifest(join(repositoryRoot, 'registry.json'))
    expect(registry).not.toBeNull()
    const output = await mkdtemp(join(tmpdir(), 'verified-registry-build-'))
    const requireFromWeb = createRequire(resolve(import.meta.dirname, '../../../apps/web/package.json'))
    try {
      await build({
        configFile: false,
        envFile: false,
        root: repositoryRoot,
        logLevel: 'silent',
        plugins: [verifiedRegistryPlugin(registry!), verifiedModuleBoundaryPlugin(registry!, [resolve(import.meta.dirname, '../src')], [join(repositoryRoot, 'index.html').replaceAll('\\', '/'), join(repositoryRoot, 'entry.ts').replaceAll('\\', '/')])],
        resolve: { alias: Object.fromEntries(['react/jsx-dev-runtime', 'react/jsx-runtime', 'react'].map(name => [name, requireFromWeb.resolve(name)])) },
        esbuild: { jsx: 'automatic' },
        build: { outDir: output, emptyOutDir: true, minify: false },
      })
      expect(await readFile(join(output, 'registry-assets/mark.svg'), 'utf8')).toContain('<svg')
      expect(await readFile(join(output, 'registry-assets/fixture.woff2'), 'utf8')).toBe('checked-in-font-fixture\n')
      const bundleName = (await readdir(join(output, 'assets'))).find(name => name.endsWith('.js'))
      expect(bundleName).toBeTruthy()
      const bundle = await readFile(join(output, 'assets', bundleName!), 'utf8')
      expect(bundle).toContain('verified-alert')
      expect(bundle).toContain('/registry-assets/mark.svg')
    } finally {
      await rm(output, { recursive: true, force: true })
    }
  }, 30_000)

  it('scopes verified asset and font URLs to the active Vite base', async () => {
    const registry = await verifyComponentRegistry(repositoryRoot, request)
    const plugin = verifiedRegistryPlugin(registry)
    plugin.configResolved({ base: '/build/7/' } as never)
    const registryModule = plugin.load('\0virtual:canvas-verified-component-registry') as string
    const fontCss = plugin.load('\0virtual:canvas-verified-component-fonts.css') as string
    expect(registryModule).toContain('/build/7/registry-assets/mark.svg')
    expect(fontCss).toContain('/build/7/registry-assets/fixture.woff2')
  })

  it('refuses missing exports, privileged imports, path escape, duplicate ids, and stale integrity', async () => {
    await expect(verifyComponentRegistry(repositoryRoot, { ...request, components: [{ ...request.components[0], exportName: 'MissingPanel' }] })).rejects.toThrow('could not be verified')
    await expect(verifyComponentRegistry(repositoryRoot, { ...request, components: [request.components[0], request.components[0]] })).rejects.toThrow('duplicate')
    await expect(verifyComponentRegistry(repositoryRoot, { ...request, components: [{ ...request.components[0], entryPath: '../outside.tsx' }] })).rejects.toThrow('escapes the verified repository')

    const temporary = await mkdtemp(join(tmpdir(), 'verified-registry-negative-'))
    try {
      await writeFile(join(temporary, 'package.json'), '{"type":"module"}')
      await writeFile(join(temporary, 'Bad.tsx'), `import fs from 'node:fs'\nexport function Bad() { return fs ? null : null }`)
      await expect(verifyComponentRegistry(temporary, { version: 1, entry: { componentId: 'bad' }, components: [component({ componentId: 'bad', entryPath: 'Bad.tsx', exportName: 'Bad' })] })).rejects.toThrow('Privileged import')
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('verifies the complete local graph and rejects privileged imports hidden in a helper', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'verified-registry-transitive-'))
    try {
      await writeFile(join(temporary, 'package.json'), '{"type":"module"}')
      await writeFile(join(temporary, 'Panel.tsx'), `import { helper } from './helper'\nexport function Panel() { return helper() }`)
      await writeFile(join(temporary, 'helper.ts'), `import fs from 'node:fs'\nexport const helper = () => fs ? null : null`)
      await expect(verifyComponentRegistry(temporary, { version: 1, entry: { componentId: 'panel' }, components: [component({ componentId: 'panel', entryPath: 'Panel.tsx', exportName: 'Panel' })] })).rejects.toThrow('Privileged import')
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('fingerprints transitive component, provider, adapter, stylesheet, and stylesheet asset dependencies', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'verified-registry-graph-'))
    try {
      await writeReactPackageContract(temporary)
      await writeFile(join(temporary, 'Panel.tsx'), `import { componentValue } from './component-helper'\nexport function Panel() { return componentValue }`)
      await writeFile(join(temporary, 'component-helper.ts'), `export const componentValue = null`)
      await writeFile(join(temporary, 'Provider.tsx'), `import { providerValue } from './provider-helper'\nexport function Provider() { return providerValue }`)
      await writeFile(join(temporary, 'provider-helper.ts'), `export const providerValue = null`)
      await writeFile(join(temporary, 'adapter.ts'), `import { adapter } from './adapter-helper'\nexport const themeAdapter = adapter`)
      await writeFile(join(temporary, 'adapter-helper.ts'), `export const adapter = { id: 'fixture' }`)
      await writeFile(join(temporary, 'components.json'), JSON.stringify({ designEditor: { preview: {
        provider: { entryPath: 'Provider.tsx', exportName: 'Provider', props: {} },
        themeAdapters: [{ entryPath: 'adapter.ts', exportName: 'themeAdapter' }],
      } } }))
      await writeFile(join(temporary, 'root.css'), `@import './nested.css';`)
      await writeFile(join(temporary, 'nested.css'), `.fixture { background: url('./mark.svg') }`)
      await writeFile(join(temporary, 'mark.svg'), `<svg xmlns="http://www.w3.org/2000/svg"/>`)
      const registry = await verifyComponentRegistry(temporary, {
        version: 1,
        entry: { componentId: 'panel' },
        components: [component({ componentId: 'panel', entryPath: 'Panel.tsx', exportName: 'Panel' })],
        styles: [{ path: 'root.css' }],
        provider: { entryPath: 'Provider.tsx', exportName: 'Provider', props: {}, evidence: { configPath: 'components.json' } },
        themeAdapters: [{ entryPath: 'adapter.ts', exportName: 'themeAdapter', evidence: { configPath: 'components.json' } }],
      })
      expect(registry.dependencies.map(file => file.path)).toEqual([
        'adapter-helper.ts',
        'component-helper.ts',
        'mark.svg',
        'nested.css',
        'provider-helper.ts',
      ])
      expect(new Set(registry.dependencies.map(file => file.integrity)).size).toBe(registry.dependencies.length)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('hashes every local dependency and rejects a dependency changed after verification', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'verified-registry-mutation-'))
    try {
      await writeReactPackageContract(temporary)
      await writeFile(join(temporary, 'Panel.tsx'), `import { helper } from './helper'\nexport function Panel() { return helper() }`)
      const helperPath = join(temporary, 'helper.ts')
      await writeFile(helperPath, `export const helper = () => 'first'`)
      const registry = await verifyComponentRegistry(temporary, { version: 1, entry: { componentId: 'panel' }, components: [component({ componentId: 'panel', entryPath: 'Panel.tsx', exportName: 'Panel' })] })
      expect(registry.dependencies).toHaveLength(1)
      expect(registry.dependencies[0]?.path).toBe('helper.ts')
      const originalFingerprint = registry.fingerprint
      const boundary = verifiedModuleBoundaryPlugin(registry)
      const verifiedSource = await boundary.load(helperPath.replaceAll('\\', '/'))
      expect(verifiedSource).toContain("'first'")
      await writeFile(helperPath, `export const helper = () => 'second'`)
      expect(verifiedSource).toContain("'first'")
      expect(verifiedSource).not.toContain("'second'")
      await expect(boundary.load(helperPath.replaceAll('\\', '/'))).rejects.toThrow('changed before build')
      const changed = await verifyComponentRegistry(temporary, { version: 1, entry: { componentId: 'panel' }, components: [component({ componentId: 'panel', entryPath: 'Panel.tsx', exportName: 'Panel' })] })
      expect(changed.fingerprint).not.toBe(originalFingerprint)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('pins bare imports to the repository package manifest and lockfile', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'verified-registry-packages-'))
    try {
      await mkdir(join(temporary, 'node_modules/tiny-preview-package'), { recursive: true })
      await writeFile(join(temporary, 'node_modules/tiny-preview-package/package.json'), JSON.stringify({ name: 'tiny-preview-package', version: '1.0.0', type: 'module', exports: './index.js' }))
      await writeFile(join(temporary, 'node_modules/tiny-preview-package/index.js'), `export const value = 'verified'`)
      await writeFile(join(temporary, 'Panel.tsx'), `import { value } from 'tiny-preview-package'\nexport function Panel() { return value }`)
      const packagePath = join(temporary, 'package.json')
      const lockPath = join(temporary, 'package-lock.json')
      const packageManifest = { name: 'fixture', version: '1.0.0', dependencies: { ...reactDependencies, 'tiny-preview-package': '1.0.0' } }
      const lockfile = { name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { dependencies: { ...reactDependencies, 'tiny-preview-package': '1.0.0' } }, 'node_modules/react': { version: '19.3.0' }, 'node_modules/react-dom': { version: '19.3.0' }, 'node_modules/tiny-preview-package': { version: '1.0.0' } } }
      await writeFile(packagePath, JSON.stringify(packageManifest))
      await writeFile(lockPath, JSON.stringify(lockfile))
      const packageRequest = { version: 1 as const, entry: { componentId: 'panel' }, components: [component({ componentId: 'panel', entryPath: 'Panel.tsx', exportName: 'Panel' })] }
      const first = await verifyComponentRegistry(temporary, packageRequest)
      const boundary = verifiedModuleBoundaryPlugin(first)
      expect(first.packageResolution?.specifiers).toEqual(expect.arrayContaining([expect.objectContaining({ specifier: 'tiny-preview-package', packageName: 'tiny-preview-package' })]))
      expect(first.packageResolution?.manifest.path).toBe('package.json')
      expect(first.packageResolution?.lockfile.path).toBe('package-lock.json')
      await expect(boundary.buildStart()).resolves.toBeUndefined()

      await writeFile(packagePath, JSON.stringify({ name: 'fixture-renamed', version: '1.0.0', dependencies: { ...reactDependencies, 'tiny-preview-package': '1.0.0' } }))
      await expect(boundary.buildStart()).rejects.toThrow('changed before build')
      const packageChanged = await verifyComponentRegistry(temporary, packageRequest)
      expect(packageChanged.fingerprint).not.toBe(first.fingerprint)
      await writeFile(packagePath, JSON.stringify(packageManifest))
      await writeFile(lockPath, JSON.stringify({ ...lockfile, fixtureMutation: true }))
      await expect(boundary.buildStart()).rejects.toThrow('changed before build')
      const lockChanged = await verifyComponentRegistry(temporary, packageRequest)
      expect(lockChanged.fingerprint).not.toBe(first.fingerprint)
      await writeFile(lockPath, JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { dependencies: { ...reactDependencies, 'tiny-preview-package': '1.0.0' } }, 'node_modules/react': { version: '19.3.0' }, 'node_modules/react-dom': { version: '19.3.0' }, 'node_modules/tiny-preview-package': { version: '1.0.1' } } }))
      await expect(verifyComponentRegistry(temporary, packageRequest)).rejects.toThrow('does not match the repository lockfile')
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('rejects undeclared, unlocked, and arbitrary node_modules imports', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'verified-registry-package-negative-'))
    try {
      await mkdir(join(temporary, 'node_modules/tiny-preview-package'), { recursive: true })
      await writeFile(join(temporary, 'node_modules/tiny-preview-package/package.json'), JSON.stringify({ name: 'tiny-preview-package', version: '1.0.0', type: 'module', exports: './index.js' }))
      const packageEntry = join(temporary, 'node_modules/tiny-preview-package/index.js')
      await writeFile(packageEntry, `export const value = 'verified'`)
      await writeFile(join(temporary, 'Panel.tsx'), `import { value } from 'tiny-preview-package'\nexport function Panel() { return value }`)
      const packageRequest = { version: 1 as const, entry: { componentId: 'panel' }, components: [component({ componentId: 'panel', entryPath: 'Panel.tsx', exportName: 'Panel' })] }
      await writeFile(join(temporary, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: reactDependencies }))
      await expect(verifyComponentRegistry(temporary, packageRequest)).rejects.toThrow('declared by the repository package manifest')
      await writeFile(join(temporary, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { ...reactDependencies, 'tiny-preview-package': '1.0.0' } }))
      await expect(verifyComponentRegistry(temporary, packageRequest)).rejects.toThrow('supported repository lockfile')
      await writeFile(join(temporary, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { dependencies: { ...reactDependencies, 'tiny-preview-package': '1.0.0' } }, 'node_modules/react': { version: '19.3.0' }, 'node_modules/react-dom': { version: '19.3.0' }, 'node_modules/tiny-preview-package': { version: '1.0.0' } } }))
      const registry = await verifyComponentRegistry(temporary, packageRequest)
      const boundary = verifiedModuleBoundaryPlugin(registry)
      await expect(boundary.load(join(temporary, 'node_modules/unapproved/index.js').replaceAll('\\', '/'))).rejects.toThrow('escaped the verified repository')
      await expect(boundary.load(packageEntry.replaceAll('\\', '/'))).resolves.toBeNull()
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('resolves declared tsconfig aliases and invalidates pinned targets and alias configuration', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'verified-registry-alias-'))
    try {
      await writeReactPackageContract(temporary)
      await writeFile(join(temporary, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }))
      await writeFile(join(temporary, 'Panel.tsx'), `import { label } from '@/label'\nexport function Panel() { return label }`)
      await mkdir(join(temporary, 'src'), { recursive: true })
      const target = join(temporary, 'src/label.ts')
      await writeFile(target, `export const label = 'first'`)
      const aliasRequest = {
        version: 1 as const,
        entry: { componentId: 'panel' },
        components: [component({ componentId: 'panel', entryPath: 'Panel.tsx', exportName: 'Panel' })],
        aliases: [{ configPath: 'tsconfig.json', baseUrl: '.', paths: [{ pattern: '@/*', target: './src/*' }] }],
      }
      const first = await verifyComponentRegistry(temporary, aliasRequest)
      expect(first.resolutions).toEqual([expect.objectContaining({ importer: 'Panel.tsx', specifier: '@/label', path: 'src/label.ts' })])
      const pinned = { ...aliasRequest, dependencies: first.dependencies.map(({ path, integrity }) => ({ path, integrity })) }
      await writeFile(target, `export const label = 'second'`)
      await expect(verifyComponentRegistry(temporary, pinned)).rejects.toThrow('Verified dependency graph changed')
      const changed = await verifyComponentRegistry(temporary, aliasRequest)
      expect(changed.fingerprint).not.toBe(first.fingerprint)

      const configPinned = {
        ...aliasRequest,
        aliases: [{ ...aliasRequest.aliases[0]!, integrity: first.aliases[0]!.integrity }],
      }
      await writeFile(join(temporary, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./different/*'] } } }))
      await expect(verifyComponentRegistry(temporary, configPinned)).rejects.toThrow('changed after the registry was generated')
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('rejects missing, ambiguous, escaping, and unsupported aliases plus nonliteral dynamic imports', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'verified-registry-alias-negative-'))
    try {
      await writeFile(join(temporary, 'Panel.tsx'), `import { label } from '@/label'\nexport function Panel() { return label }`)
      await expect(verifyComponentRegistry(temporary, { version: 1, entry: { componentId: 'panel' }, components: [component({ componentId: 'panel', entryPath: 'Panel.tsx', exportName: 'Panel' })] })).rejects.toThrow('no verified configuration')

      await writeFile(join(temporary, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*', './other/*'] } } }))
      await expect(verifyComponentRegistry(temporary, {
        version: 1,
        entry: { componentId: 'panel' },
        components: [component({ componentId: 'panel', entryPath: 'Panel.tsx', exportName: 'Panel' })],
        aliases: [{ configPath: 'tsconfig.json', baseUrl: '.', paths: [{ pattern: '@/*', target: './src/*' }] }],
      })).rejects.toThrow('ambiguous')

      await writeFile(join(temporary, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '..', paths: { '@/*': ['./src/*'] } } }))
      await expect(verifyComponentRegistry(temporary, {
        version: 1,
        entry: { componentId: 'panel' },
        components: [component({ componentId: 'panel', entryPath: 'Panel.tsx', exportName: 'Panel' })],
        aliases: [{ configPath: 'tsconfig.json', baseUrl: '..', paths: [{ pattern: '@/*', target: './src/*' }] }],
      })).rejects.toThrow('escapes the verified repository')

      await writeFile(join(temporary, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*/deep': ['./src/*/deep'] } } }))
      await expect(verifyComponentRegistry(temporary, {
        version: 1,
        entry: { componentId: 'panel' },
        components: [component({ componentId: 'panel', entryPath: 'Panel.tsx', exportName: 'Panel' })],
        aliases: [{ configPath: 'tsconfig.json', baseUrl: '.', paths: [{ pattern: '@/*/deep', target: './src/*/deep' }] }],
      })).rejects.toThrow('unsupported wildcard')

      await writeFile(join(temporary, 'Panel.tsx'), `const name = './helper'\nexport async function Panel() { return import(name) }`)
      await expect(verifyComponentRegistry(temporary, { version: 1, entry: { componentId: 'panel' }, components: [component({ componentId: 'panel', entryPath: 'Panel.tsx', exportName: 'Panel' })] })).rejects.toThrow('Dynamic imports need a verified adapter')
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('discovers only statically referenced nested CSS assets and invalidates a pinned asset mutation', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'verified-registry-css-assets-'))
    try {
      await writeReactPackageContract(temporary)
      await writeFile(join(temporary, 'Panel.tsx'), `export function Panel() { return null }`)
      await writeFile(join(temporary, 'root.css'), `@import './theme/nested.css';`)
      await mkdir(join(temporary, 'theme'), { recursive: true })
      await writeFile(join(temporary, 'theme/nested.css'), `.mark { background-image: url('./mark.svg') }`)
      const assetPath = join(temporary, 'theme/mark.svg')
      await writeFile(assetPath, `<svg xmlns="http://www.w3.org/2000/svg"/>`)
      await writeFile(join(temporary, 'unreferenced.svg'), `<svg xmlns="http://www.w3.org/2000/svg"><path/></svg>`)
      const cssRequest = { version: 1 as const, entry: { componentId: 'panel' }, components: [component({ componentId: 'panel', entryPath: 'Panel.tsx', exportName: 'Panel' })], styles: [{ path: 'root.css' }] }
      const first = await verifyComponentRegistry(temporary, cssRequest)
      expect(first.assets.map(asset => asset.sourcePath)).toEqual(['theme/mark.svg'])
      expect(first.assets.some(asset => asset.sourcePath === 'unreferenced.svg')).toBe(false)
      const pinned = { ...cssRequest, dependencies: first.dependencies.map(({ path, integrity }) => ({ path, integrity })) }
      await writeFile(assetPath, `<svg xmlns="http://www.w3.org/2000/svg"><path/></svg>`)
      await expect(verifyComponentRegistry(temporary, pinned)).rejects.toThrow('Verified dependency graph changed')
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('accepts provider metadata only when it matches explicit scanner evidence', async () => {
    await expect(verifyComponentRegistry(repositoryRoot, {
      ...request,
      provider: { ...request.provider, props: { mode: 'guessed' } },
    })).rejects.toThrow('does not match scanner configuration evidence')
    await expect(verifyComponentRegistry(repositoryRoot, {
      ...request,
      provider: { entryPath: 'src/PreviewProvider.tsx', exportName: 'PreviewProvider', props: {} },
    })).rejects.toThrow('Invalid registry provider')
  })

  it('allows only declared HTTP and HTML entry routes through the module boundary', async () => {
    const registry = await verifyComponentRegistry(repositoryRoot, request)
    const htmlEntry = join(repositoryRoot, 'index.html').replaceAll('\\', '/')
    const plugin = verifiedModuleBoundaryPlugin(registry, [], ['/thumbnail-renderer', htmlEntry])
    await expect(plugin.load('/thumbnail-renderer')).resolves.toBeNull()
    await expect(plugin.load(htmlEntry)).resolves.toBeNull()
    await expect(plugin.load('/unapproved-route')).rejects.toThrow('escaped the verified repository')
    await expect(plugin.load(join(repositoryRoot, 'unapproved.html').replaceAll('\\', '/'))).rejects.toThrow('escaped the verified repository')
  })
})
