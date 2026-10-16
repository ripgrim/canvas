import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import postcss, { type Node as PostCssNode } from 'postcss'
import { Node, Project, SyntaxKind, ts } from 'ts-morph'
import { confined } from './paths.js'
import type { ShadcnComponent, ShadcnConfig, ShadcnDiagnostic, ShadcnModuleConfig, ShadcnProp, ShadcnScan, ShadcnToken } from './contracts.js'
import { compareText } from './ordering.js'
export type { ShadcnComponent, ShadcnConfig, ShadcnDiagnostic, ShadcnProp, ShadcnScan, ShadcnToken } from './contracts.js'

type RawComponentsConfig = {
  aliases?: { ui?: unknown }
  tailwind?: { css?: unknown }
  registries?: unknown
  designEditor?: { preview?: { provider?: unknown; themeAdapters?: unknown } }
}

const ignoredDirectories = new Set(['.git', '.next', '.output', '.turbo', '.vite', 'build', 'coverage', 'dist', 'node_modules'])
const uiDirectoryCandidates = ['src/app/components/ui', 'src/components/ui', 'app/components/ui', 'components/ui'] as const
const stylesheetCandidates = ['globals.css', 'styles.css', 'styles/globals.css', 'src/globals.css', 'src/styles.css', 'src/styles/globals.css', 'app/globals.css', 'app/styles.css', 'src/app/globals.css', 'src/app/styles.css'] as const
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const posix = (value: string) => value.replaceAll('\\', '/')
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

async function walk(root: string, directory = ''): Promise<string[]> {
  const entries = await readdir(directory ? await confined(root, directory) : root, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue
    const relative = posix(path.join(directory, entry.name))
    if (entry.isSymbolicLink()) throw new Error(`Source links need an explicit adapter: ${relative}`)
    if (entry.isDirectory()) files.push(...await walk(root, relative))
    else files.push(relative)
  }
  return files
}

async function existingDirectory(root: string, relative: string): Promise<boolean> {
  try { return (await stat(await confined(root, relative))).isDirectory() } catch { return false }
}

async function existingFile(root: string, relative: string): Promise<boolean> {
  try { return (await stat(await confined(root, relative))).isFile() } catch { return false }
}

function stringMapKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value).filter((key) => typeof (value as Record<string, unknown>)[key] === 'string')
}

function explicitPreviewConfig(raw: RawComponentsConfig, workspace: string): Pick<ShadcnConfig, 'previewProvider' | 'themeAdapters'> {
  const value = raw.designEditor?.preview
  const provider = value?.provider
  const previewProvider = provider && typeof provider === 'object' && !Array.isArray(provider)
    && typeof (provider as Record<string, unknown>).entryPath === 'string'
    && typeof (provider as Record<string, unknown>).exportName === 'string'
    && ((provider as Record<string, unknown>).props === undefined || (provider as Record<string, unknown>).props !== null && typeof (provider as Record<string, unknown>).props === 'object' && !Array.isArray((provider as Record<string, unknown>).props))
    ? {
        entryPath: posix(path.join(workspace, (provider as Record<string, string>).entryPath!)),
        exportName: (provider as Record<string, string>).exportName!,
        props: ((provider as Record<string, unknown>).props ?? {}) as Record<string, string | number | boolean | null>,
      }
    : null
  const adapters = Array.isArray(value?.themeAdapters) ? value.themeAdapters : []
  const themeAdapters = adapters.flatMap(adapter => adapter && typeof adapter === 'object' && !Array.isArray(adapter)
    && typeof (adapter as Record<string, unknown>).entryPath === 'string'
    && typeof (adapter as Record<string, unknown>).exportName === 'string'
    ? [{ entryPath: posix(path.join(workspace, (adapter as Record<string, string>).entryPath!)), exportName: (adapter as Record<string, string>).exportName! }]
    : [])
  return { previewProvider, themeAdapters }
}

async function moduleConfig(root: string, workspace: string): Promise<ShadcnModuleConfig | null> {
  for (const filename of ['tsconfig.json', 'jsconfig.json']) {
    const relative = posix(path.join(workspace, filename))
    if (!await existingFile(root, relative)) continue
    try {
      const parsed = ts.parseConfigFileTextToJson(relative, await readFile(await confined(root, relative), 'utf8')).config
      const compiler = parsed?.compilerOptions ?? {}
      return {
        path: relative,
        baseUrl: posix(path.join(workspace, typeof compiler.baseUrl === 'string' ? compiler.baseUrl : '.')),
        paths: Object.fromEntries(Object.entries(compiler.paths ?? {}).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((item) => typeof item === 'string'))),
      }
    } catch { return null }
  }
  return null
}

function aliasCandidates(alias: string, aliases: ShadcnModuleConfig | null, workspace: string): string[] {
  const base = aliases?.baseUrl ?? workspace
  if (alias.startsWith('./') || alias.startsWith('../')) return [posix(path.join(base, alias))]
  const candidates: string[] = []
  for (const [pattern, targets] of Object.entries(aliases?.paths ?? {})) {
    const star = pattern.indexOf('*')
    const prefix = star < 0 ? pattern : pattern.slice(0, star)
    const suffix = star < 0 ? '' : pattern.slice(star + 1)
    if (star < 0 ? alias !== pattern : !alias.startsWith(prefix) || !alias.endsWith(suffix)) continue
    const capture = star < 0 ? '' : alias.slice(prefix.length, suffix ? -suffix.length : undefined)
    for (const target of targets) candidates.push(posix(path.join(base, target.replace('*', capture))))
  }
  return candidates
}

async function parseConfig(root: string, configPath: string, diagnostics: ShadcnDiagnostic[]): Promise<ShadcnConfig | null> {
  const workspace = posix(path.dirname(configPath)) === '.' ? '' : posix(path.dirname(configPath))
  let raw: RawComponentsConfig
  try { raw = JSON.parse(await readFile(await confined(root, configPath), 'utf8')) as RawComponentsConfig } catch {
    diagnostics.push({ code: 'invalid-config', path: configPath, message: 'components.json is not valid JSON.' })
    return null
  }
  const uiAlias = typeof raw.aliases?.ui === 'string' ? raw.aliases.ui : null
  const aliases = await moduleConfig(root, workspace)
  const configuredRoots = uiAlias ? aliasCandidates(uiAlias, aliases, workspace) : []
  const fallbacks = [...uiDirectoryCandidates, 'src/components'].map(candidate => posix(path.join(workspace, candidate)))
  const uiRoots: string[] = []
  for (const candidate of [...configuredRoots, ...fallbacks]) {
    if (uiRoots.some((existing) => existing === candidate || existing.startsWith(`${candidate}/`))) continue
    if (await existingDirectory(root, candidate)) uiRoots.push(candidate)
  }
  if (!uiRoots.length) diagnostics.push({ code: 'missing-ui-root', path: configPath, message: 'No configured shadcn UI source root was found.' })
  const registryRoots: string[] = []
  for (const candidate of ['registry', 'registries'].map((directory) => posix(path.join(workspace, directory)))) {
    if (await existingDirectory(root, candidate)) registryRoots.push(candidate)
  }

  const configuredCss = typeof raw.tailwind?.css === 'string' && raw.tailwind.css.length ? posix(path.join(workspace, raw.tailwind.css)) : null
  const cssFallbacks = stylesheetCandidates.map(candidate => posix(path.join(workspace, candidate)))
  const tokenFiles: string[] = []
  for (const candidate of [configuredCss, ...cssFallbacks]) if (candidate && !tokenFiles.includes(candidate) && await existingFile(root, candidate)) tokenFiles.push(candidate)
  if (!tokenFiles.length) diagnostics.push({ code: 'missing-css', path: configPath, message: 'No configured shadcn globals stylesheet was found.' })

  const registries = Array.isArray(raw.registries)
    ? raw.registries.filter((entry): entry is string => typeof entry === 'string')
    : stringMapKeys(raw.registries)
  return { source: 'manifest', path: configPath, workspace, uiAlias, uiRoots, registryRoots, tokenFiles, registries, moduleConfig: aliases, ...explicitPreviewConfig(raw, workspace) }
}

function inferredWorkspace(filename: string): { workspace: string; uiRoot: string } | null {
  for (const candidate of uiDirectoryCandidates) {
    const marker = `${candidate}/`
    if (filename.startsWith(marker)) return { workspace: '', uiRoot: candidate }
    const index = filename.indexOf(`/${marker}`)
    if (index >= 0) {
      const workspace = filename.slice(0, index)
      return { workspace, uiRoot: `${workspace}/${candidate}` }
    }
  }
  return null
}

async function inferConfigs(root: string, paths: readonly string[], occupiedWorkspaces: ReadonlySet<string>, diagnostics: ShadcnDiagnostic[]): Promise<ShadcnConfig[]> {
  const files = new Set(paths)
  const rootsByWorkspace = new Map<string, Set<string>>()
  for (const filename of paths) {
    if (!/\.[cm]?tsx$/.test(filename)) continue
    const inferred = inferredWorkspace(filename)
    if (!inferred || occupiedWorkspaces.has(inferred.workspace)) continue
    const packageFile = posix(path.join(inferred.workspace, 'package.json'))
    if (!files.has(packageFile)) continue
    const roots = rootsByWorkspace.get(inferred.workspace) ?? new Set<string>()
    roots.add(inferred.uiRoot)
    rootsByWorkspace.set(inferred.workspace, roots)
  }
  const configs: ShadcnConfig[] = []
  for (const [workspace, roots] of [...rootsByWorkspace].sort(([left], [right]) => compareText(left, right))) {
    const pathInWorkspace = (candidate: string) => posix(path.join(workspace, candidate))
    const tokenFiles = stylesheetCandidates.map(pathInWorkspace).filter(filename => files.has(filename))
    const registryRoots: string[] = []
    for (const candidate of ['registry', 'registries'].map(pathInWorkspace)) if (await existingDirectory(root, candidate)) registryRoots.push(candidate)
    const configPath = pathInWorkspace('package.json')
    if (!tokenFiles.length) diagnostics.push({ code: 'missing-css', path: configPath, message: 'No globals.css or styles.css token stylesheet was found beside the inferred UI source root.' })
    configs.push({
      source: 'inferred',
      path: configPath,
      workspace,
      uiAlias: null,
      uiRoots: [...roots].sort(),
      registryRoots,
      tokenFiles,
      registries: [],
      moduleConfig: await moduleConfig(root, workspace),
      previewProvider: null,
      themeAdapters: [],
    })
  }
  return configs
}

function unwrapComponentDeclaration(declaration: Node): { kind: ShadcnComponent['declarationKind']; body: Node; propsAt: Node | null } | null {
  if (Node.isFunctionDeclaration(declaration)) return { kind: 'function', body: declaration, propsAt: declaration.getParameters()[0] ?? null }
  if (!Node.isVariableDeclaration(declaration)) return null
  let expression: Node | undefined = declaration.getInitializer()
  if (!expression) return null
  let kind: ShadcnComponent['declarationKind'] = 'variable'
  let declaredProps: Node | null = null
  while (Node.isCallExpression(expression)) {
    const name = expression.getExpression().getText().split('.').at(-1)
    if (name !== 'forwardRef' && name !== 'memo') break
    kind = name
    if (name === 'forwardRef') declaredProps = expression.getTypeArguments()[1] ?? declaredProps
    const next: Node | undefined = expression.getArguments()[0]
    if (!next) break
    expression = next
  }
  if (!Node.isArrowFunction(expression) && !Node.isFunctionExpression(expression)) return null
  return { kind, body: expression, propsAt: declaredProps ?? expression.getParameters()[0] ?? null }
}

function componentProps(location: Node | null): ShadcnProp[] {
  if (!location) return []
  if (Node.isTypeReference(location)) {
    const declaration = location.getSourceFile().getTypeAlias(location.getTypeName().getText())
    const literal = declaration?.getTypeNode()
    if (literal && Node.isTypeLiteral(literal)) return literal.getProperties().map((property) => ({
      name: property.getName(),
      type: property.getTypeNode()?.getText() ?? property.getType().getText(property),
      optional: property.hasQuestionToken(),
    })).sort((left, right) => compareText(left.name, right.name))
  }
  return location.getType().getProperties().map((symbol) => ({
    name: symbol.getName(),
    type: symbol.getTypeAtLocation(location).getText(location),
    optional: symbol.isOptional(),
  })).sort((left, right) => compareText(left.name, right.name))
}

function declarationFingerprint(node: Node): string {
  const parts: string[] = []
  const visit = (current: Node) => {
    if (Node.isIdentifier(current) && current.getParent() === node) parts.push('DeclarationName')
    else if (current.getChildCount() === 0) parts.push(`${current.getKind()}:${current.getText()}`)
    else current.forEachChild(visit)
  }
  visit(node)
  return hash(parts.join('|'))
}

function workspacePackageName(source: string | undefined): string | null {
  if (!source) return null
  try {
    const value = (JSON.parse(source) as { name?: unknown }).name
    return typeof value === 'string' && value.length <= 214 && packageNamePattern.test(value) ? value : null
  } catch { return null }
}

function hasUseServerDirective(node: Node): boolean {
  const statements = Node.isSourceFile(node)
    ? node.getStatements()
    : Node.isFunctionDeclaration(node) || Node.isArrowFunction(node) || Node.isFunctionExpression(node)
      ? (() => {
          const body = node.getBody()
          return body && Node.isBlock(body) ? body.getStatements() : []
        })()
      : []
  for (const statement of statements) {
    if (!Node.isExpressionStatement(statement)) return false
    const expression = statement.getExpression()
    if (!Node.isStringLiteral(expression)) return false
    if (expression.getLiteralText() === 'use server') return true
  }
  return false
}

type ComponentOwner = Readonly<{ configPath: string; roots: readonly string[]; packageName: string | null }>

function componentOwner(relative: string, owners: readonly ComponentOwner[]): ComponentOwner | null {
  const claims = owners.flatMap(owner => owner.roots.flatMap(root => relative === root || relative.startsWith(`${root}/`) ? [{ owner, length: root.length }] : []))
  if (!claims.length) return null
  const longest = Math.max(...claims.map(claim => claim.length))
  const candidates = [...new Map(claims.filter(claim => claim.length === longest).map(claim => [claim.owner.configPath, claim.owner])).values()]
  if (candidates.length !== 1) throw new Error(`Ambiguous component owner: ${relative}`)
  return candidates[0]!
}

function discoverComponents(root: string, files: Readonly<Record<string, string>>, owners: readonly ComponentOwner[], diagnostics: ShadcnDiagnostic[]): ShadcnComponent[] {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX, strict: true, skipLibCheck: true },
  })
  for (const [relative, source] of Object.entries(files)) if (/\.[cm]?tsx?$/.test(relative)) project.createSourceFile(path.join(root, relative), source, { overwrite: true })
  const components: ShadcnComponent[] = []
  for (const [relative, source] of Object.entries(files)) {
    const owner = componentOwner(relative, owners)
    if (!owner || !/\.[cm]?tsx$/.test(relative) || /\.d\.[cm]?ts$/.test(relative)) continue
    const sourceFile = project.getSourceFile(path.join(root, relative))
    if (!sourceFile) continue
    for (const [exportName, declarations] of sourceFile.getExportedDeclarations()) for (const declaration of declarations) {
      if (Node.isTypeAliasDeclaration(declaration) || Node.isInterfaceDeclaration(declaration)) continue
      const resolved = unwrapComponentDeclaration(declaration)
      if (hasUseServerDirective(sourceFile) || hasUseServerDirective(resolved?.body ?? declaration)) {
        diagnostics.push({ code: 'unsupported-export', path: relative, message: `${exportName} is server-only and cannot be indexed as a preview component.` })
        continue
      }
      const rendersJsx = resolved?.body.getDescendants().some((node) => [SyntaxKind.JsxElement, SyntaxKind.JsxSelfClosingElement, SyntaxKind.JsxFragment].includes(node.getKind())) ?? false
      if (!resolved || !rendersJsx) {
        if (declaration.getSourceFile() === sourceFile) diagnostics.push({ code: 'unsupported-export', path: relative, message: `${exportName} is exported from the UI root but is not a supported React component declaration.` })
        continue
      }
      const props = componentProps(resolved.propsAt)
      components.push({
        path: relative,
        exportName,
        packageName: owner.packageName,
        declarationKind: resolved.kind,
        props,
        slots: props.filter((prop) => prop.name === 'children' || /ReactNode|ReactElement/.test(prop.type)).map((prop) => prop.name),
        sourceHash: hash(source),
        fingerprint: declarationFingerprint(declaration),
      })
    }
  }
  return components.sort((left, right) => compareText(left.path, right.path) || compareText(left.exportName, right.exportName))
}

function tokenTheme(selector: string): string {
  if (selector === ':root' || selector === 'html' || selector === 'body') return 'base'
  if (/(?:^|[\s,.])\.dark(?:[\s,:.#[]|$)/.test(selector)) return 'dark'
  const dataTheme = /\[data-theme=(?:"([^"]+)"|'([^']+)'|([^\]]+))\]/.exec(selector)
  return dataTheme?.[1] ?? dataTheme?.[2] ?? dataTheme?.[3] ?? 'custom'
}

function discoverTokens(relative: string, source: string): ShadcnToken[] {
  const root = postcss.parse(source, { from: relative })
  const tokens: ShadcnToken[] = []
  root.walkDecls(/^--/, (declaration) => {
    const rules: string[] = []
    const atRules: string[] = []
    let current: PostCssNode | undefined = declaration.parent
    while (current) {
      if (current.type === 'rule') rules.unshift((current as PostCssNode & { selector: string }).selector)
      else if (current.type === 'atrule') {
        const atRule = current as PostCssNode & { name: string; params: string }
        atRules.unshift(`@${atRule.name}${atRule.params ? ` ${atRule.params}` : ''}`)
      }
      current = current.parent
    }
    const selector = rules.join(' ') || atRules.at(-1) || ':root'
    const aliases = [...declaration.value.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)].map((match) => match[1]!)
    tokens.push({
      name: declaration.prop,
      value: declaration.value,
      path: relative,
      selector,
      atRules,
      theme: tokenTheme(selector),
      aliases,
      line: declaration.source?.start?.line ?? 1,
      column: declaration.source?.start?.column ?? 1,
    })
  })
  return tokens
}

export async function scanShadcnRepository(repositoryRoot: string): Promise<ShadcnScan> {
  const root = await realpath(repositoryRoot)
  const paths = await walk(root)
  const diagnostics: ShadcnDiagnostic[] = []
  const configs: ShadcnConfig[] = []
  for (const filename of paths.filter((filename) => path.posix.basename(filename) === 'components.json').sort()) {
    const parsed = await parseConfig(root, filename, diagnostics)
    if (parsed) configs.push(parsed)
  }
  configs.push(...await inferConfigs(root, paths, new Set(configs.map(config => config.workspace)), diagnostics))
  const relevant = new Set<string>()
  const repositoryFiles = new Set(paths)
  for (const config of configs) {
    const packagePath = posix(path.join(config.workspace, 'package.json'))
    if (repositoryFiles.has(packagePath)) relevant.add(packagePath)
    config.tokenFiles.forEach((filename) => relevant.add(filename))
    if (config.moduleConfig) relevant.add(config.moduleConfig.path)
    if (config.previewProvider || config.themeAdapters.length) relevant.add(config.path)
    if (config.previewProvider) relevant.add(config.previewProvider.entryPath)
    config.themeAdapters.forEach(adapter => relevant.add(adapter.entryPath))
    for (const componentRoot of [...config.uiRoots, ...config.registryRoots]) for (const filename of paths) if (filename.startsWith(`${componentRoot}/`) && /\.[cm]?tsx?$/.test(filename)) relevant.add(filename)
  }
  const files: Record<string, string> = {}
  for (const filename of [...relevant].sort()) files[filename] = await readFile(await confined(root, filename), 'utf8')
  const owners = configs.map(config => ({
    configPath: config.path,
    roots: [...config.uiRoots, ...config.registryRoots],
    packageName: workspacePackageName(files[posix(path.join(config.workspace, 'package.json'))]),
  })).sort((left, right) => compareText(left.configPath, right.configPath))
  const components = discoverComponents(root, files, owners, diagnostics)
  const tokens = configs.flatMap((config) => config.tokenFiles).filter((filename, index, all) => all.indexOf(filename) === index).flatMap((filename) => discoverTokens(filename, files[filename]!))
  return {
    adapterId: 'shadcn-v1',
    configs,
    components,
    tokens,
    sourceHashes: Object.fromEntries(Object.entries(files).map(([filename, source]) => [filename, hash(source)])),
    diagnostics,
  }
}
