import { randomUUID } from 'node:crypto'
import { mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { createTwoFilesPatch } from 'diff'
import postcss from 'postcss'
import { discover, hash, makeProject, reconcile, sourceFiles } from './discovery.js'
import { confined, metadataDirectory, readOptional } from './paths.js'
import { appendExport, parseTsx, patchLabelPadding, patchToken, promotionSource } from './patches.js'
import { createDocument } from './document.js'
import type { DocumentValidationOptions, EditorDocument } from './document.js'
import { fileFromLegacyDocument, loadFile, readDocumentState, saveDocument as persistDocument } from './document-persistence.js'
import { designThemesFromTokens } from './design-themes.js'
import { legacyPageDocument, pageNodes } from './file-document.js'
import type { FileDocument } from './file-document.js'
import { planBlumeComponentDocs } from './component-docs-blume.js'
import type { BlumeComponentDocsLayout, BlumeComponentExample } from './component-docs-blume.js'
import type { ComponentDocsCatalog } from './component-model.js'
export * from './design-themes.js'
export * from './file-document.js'
export * from './file-migration.js'
export * from './file-preview.js'
export * from './color.js'
export * from './order-keys.js'
export * from './node-theme.js'
export * from './component-model.js'
export * from './component-docs-blume.js'
export * from './component-docs-adapter.js'
export * from './hosted-source-review.js'
export * from './layout.js'
export * from './transform-matrix.js'
export type { Rect as LayoutRect } from './flex-inference.js'
export * from './grid-tracks.js'
export * from './grid-placement.js'
export { inferFlexLayout } from './flex-inference.js'
export type { FlexInference, FlexInferenceInput } from './flex-inference.js'
export * as layoutMatrix from './layout-matrix.js'
import { documentPromotionSource, promotionLayoutStyles } from './document-promotion.js'
export { promotionLayoutStyles } from './document-promotion.js'
export type { LayoutStyles } from './document-promotion.js'
import type { Atom, Composition, Conflict, EngineOptions, FileChange, PreparedChange, ProjectSnapshot, SaveResult } from './types.js'

export type * from './types.js'

type Metadata = { version: 1; projectId: string; atoms: Atom[]; composition: Composition; history?: Transaction[] }
type Transaction = {
  public: PreparedChange
  inputs: Record<string, string>
  promotionName: string | null
  digest: string
  consumed: boolean
  reverseAction: 'undo' | 'redo'
  compositionBefore: Composition
  compositionAfter: Composition | null
  targetComposition: Composition | null
  promotedBinding: Atom | null
  reverseBinding: Atom | null
}
type Journal = { version: 1; id: string; status: 'writing' | 'saved' | 'rolled-back' | 'recovery-required'; files: FileChange[]; message: string }
const adapterVersion = 'vite-client-fixture/1'
const validationVersion = 'babel-postcss-typescript/1'

async function atomicText(root: string, relative: string, value: string) {
  const target = await confined(root, relative)
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${relative}.${randomUUID()}.tmp`
  const handle = await open(await confined(root, temporary), 'wx')
  try { await handle.writeFile(value, 'utf8'); await handle.sync() } finally { await handle.close() }
  await rename(await confined(root, temporary), await confined(root, relative))
}

function digest(change: PreparedChange, inputs: Record<string, string>, composition: Composition): string {
  return hash(JSON.stringify({ adapterVersion, validationVersion, id: change.id, scope: change.scope, summary: change.summary, inputs, files: change.files, validation: change.validation, composition }))
}

/** JSON with object keys sorted, so two documents compare by content rather than by key insertion order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}
const compositionContent = (document: EditorDocument) => stableJson({ rootIds: document.rootIds, nodes: document.nodes })

function changedPaths(expected: Record<string, string>, actual: Record<string, string>): string[] {
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter(file => expected[file] !== actual[file]).sort()
}

export class RepoEngine {
  private metadata: Metadata
  private conflict: Conflict | null = null
  private prepared = new Map<string, Transaction>()
  private saved = new Map<string, Transaction>()
  private pending: Promise<unknown> = Promise.resolve()
  private documentHash: string | null | undefined

  private constructor(readonly root: string, metadata: Metadata, private options: EngineOptions) { this.metadata = metadata }

  static async open(root: string, options: EngineOptions = {}): Promise<RepoEngine> {
    const canonical = await realpath(root)
    await metadataDirectory(canonical)
    const existing = await readOptional(canonical, '.design-editor/identity.json')
    const metadata: Metadata = existing ? JSON.parse(existing) as Metadata : {
      version: 1, projectId: randomUUID(), atoms: [],
      composition: { id: randomUUID(), name: 'Login', componentId: null, children: [] },
    }
    if (metadata.version !== 1 || !Array.isArray(metadata.atoms) || typeof metadata.projectId !== 'string') throw new Error('Unsupported identity metadata')
    // Older projects stored the design preview theme here; view state now lives with the editor, so it is dropped on the next write.
    delete (metadata as { previewTheme?: unknown }).previewTheme
    const engine = new RepoEngine(canonical, metadata, options)
    for (const transaction of metadata.history ?? []) engine.saved.set(transaction.public.id, transaction)
    const journal = await readOptional(canonical, '.design-editor/transaction.json')
    if (journal) {
      const parsed = JSON.parse(journal) as Journal
      if (parsed.status === 'writing' || parsed.status === 'recovery-required') engine.conflict = { kind: 'rollback', message: 'An interrupted source transaction needs recovery before saving.', paths: parsed.files.map(file => file.path) }
    }
    return engine
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.pending.then(operation, operation)
    this.pending = task.then(() => undefined, () => undefined)
    return task
  }

  private async inputHashes(sources: Record<string, string>): Promise<Record<string, string>> {
    const inputs = { ...sources }
    for (const relative of ['package.json', 'tsconfig.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', '.design-editor/document.json']) {
      const value = await readOptional(this.root, relative)
      if (value !== null) inputs[relative] = value
    }
    return Object.fromEntries(Object.entries(inputs).map(([file, value]) => [file, hash(value)]))
  }

  private async transactionSources(paths: readonly string[] = []): Promise<Record<string, string>> {
    const sources = await sourceFiles(this.root)
    for (const relative of paths) {
      await confined(this.root, relative)
      const value = await readOptional(this.root, relative)
      if (value !== null) sources[relative] = value
    }
    return sources
  }

  private async snapshot(): Promise<ProjectSnapshot> {
    const files = await sourceFiles(this.root)
    const sourceHashes = await this.inputHashes(files)
    this.metadata.atoms = reconcile(this.metadata.atoms, discover(this.root, files))
    if (!this.metadata.composition.children.length) {
      for (const [exportName, props] of [['Label', { htmlFor: 'email', children: 'Email' }], ['Input', { id: 'email', type: 'email', placeholder: 'you@example.com' }], ['Label', { htmlFor: 'password', children: 'Password' }], ['Input', { id: 'password', type: 'password' }], ['Button', { children: 'Sign in', variant: 'primary' }]] as [string, Record<string, string>][]) {
        const atom = this.metadata.atoms.find(candidate => candidate.exportName === exportName && candidate.status === 'bound')
        if (atom) this.metadata.composition.children.push({ id: randomUUID(), componentId: atom.componentId, exportName, props })
      }
    }
    const unresolved = this.metadata.atoms.filter(atom => atom.status !== 'bound')
    if (unresolved.length) this.conflict = { kind: 'identity', message: 'A component binding needs review before saving.', paths: unresolved.map(atom => atom.path) }
    for (const transaction of this.prepared.values()) {
      if (transaction.consumed) continue
      const current = await this.inputHashes(await this.transactionSources(transaction.public.files.map(file => file.path)))
      const changes = changedPaths(transaction.inputs, current)
      if (changes.length) this.conflict = { kind: 'external-change', message: 'Source changed. Review a new patch before saving.', paths: changes }
    }
    const tokens: ProjectSnapshot['tokens'] = []
    if (files['src/globals.css']) postcss.parse(files['src/globals.css']).walkRules(rule => {
      rule.walkDecls(declaration => {
        if (declaration.prop.startsWith('--')) tokens.push({ name: declaration.prop, value: declaration.value, selector: rule.selector, path: 'src/globals.css' })
      })
    })
    const designThemes = designThemesFromTokens(tokens)
    await atomicText(this.root, '.design-editor/identity.json', JSON.stringify(this.metadata, null, 2))
    const documentState = await readDocumentState(this.root, this.metadata.projectId, this.metadata.atoms, { allowUnavailableBindings: true })
    this.documentHash = documentState.hash
    const file = documentState.file ?? this.compositionFile({ allowUnavailableBindings: true })
    return structuredClone({ projectId: this.metadata.projectId, atoms: this.metadata.atoms, sourceHashes, composition: this.metadata.composition, file, sourceHistory: [...this.saved.values()].map(transaction => ({ transactionId: transaction.public.id, summary: transaction.public.summary, action: transaction.reverseAction })), conflict: this.conflict, phases: [{ name: 'Reading project', completed: Object.keys(files).length }, { name: 'Indexing symbols', completed: this.metadata.atoms.length }], tokens, designThemes })
  }

  /** The bound composition as a one page file, used until the project stores its own design file. */
  private compositionFile(options: DocumentValidationOptions = {}): FileDocument {
    return fileFromLegacyDocument(this.metadata.projectId, createDocument(this.metadata.atoms, this.metadata.composition, options), this.metadata.atoms, options)
  }

  inspectFixture(): Promise<ProjectSnapshot> { return this.serial(() => this.snapshot()) }
  refresh(): Promise<ProjectSnapshot> {
    return this.serial(() => {
      this.prepared.clear()
      if (this.conflict?.kind === 'external-change') this.conflict = null
      return this.snapshot()
    })
  }

  /** Persists the whole design file. Source files are untouched; any reviewed source change must be prepared again. */
  saveFile(file: FileDocument, expectedRevision: number): Promise<ProjectSnapshot> {
    return this.serial(async () => {
      if (this.documentHash === undefined) throw new Error('Load the project before editing its file')
      if (typeof file !== 'object' || file === null || file.fileId !== this.metadata.projectId) throw new Error('That design file belongs to another project')
      await persistDocument(this.root, file, expectedRevision, this.metadata.atoms, this.documentHash)
      this.prepared.clear()
      return this.snapshot()
    })
  }

  private assertWritable() {
    if (this.conflict?.kind === 'rollback') throw new Error(this.conflict.message)
    if (this.metadata.atoms.some(atom => atom.status !== 'bound')) throw new Error('Resolve component identity before preparing a source change')
  }

  private async prepare(scope: PreparedChange['scope'], summary: string, changes: { path: string; after: string | null; expectedBefore: string | null }[], promotionName: string | null = null, reversal?: { action: 'undo' | 'redo'; composition: Composition | null; binding: Atom | null }, validation: 'preview' | 'documentation' = 'preview'): Promise<PreparedChange> {
    this.assertWritable()
    const sources = await this.transactionSources(changes.map(change => change.path))
    const inputs = await this.inputHashes(sources)
    const files = changes.map(change => {
      const before = sources[change.path] ?? null
      if (before !== change.expectedBefore) throw new Error('Source changed while preparing the patch. Review again.')
      return { path: change.path, after: change.after, before, diff: createTwoFilesPatch(change.path, change.path, before ?? '', change.after ?? '', 'Current source', 'Reviewed change') }
    }).filter(file => file.before !== file.after)
    if (!files.length) throw new Error('There are no source changes to review')
    const id = randomUUID()
    const staged = { ...sources }
    for (const file of files) {
      await confined(this.root, file.path)
      if (file.after === null) delete staged[file.path]
      else {
        if (/\.tsx?$/.test(file.path)) parseTsx(file.after)
        if (file.path.endsWith('.css')) postcss.parse(file.after)
        staged[file.path] = file.after
        await atomicText(this.root, `.design-editor/staged/${id}/${file.path}`, file.after)
      }
    }
    const project = makeProject(this.root, staged)
    const diagnostics = project.getPreEmitDiagnostics()
    if (diagnostics.length) throw new Error(`Source validation failed:\n${project.formatDiagnosticsWithColorAndContext(diagnostics)}`)
    const targetComposition = reversal?.composition ?? this.metadata.composition
    const bound = reversal?.binding?.componentId === targetComposition.componentId ? reversal.binding : this.metadata.atoms.find(atom => atom.componentId === targetComposition.componentId)
    const selectedBinding = promotionName
      ? { componentId: this.metadata.composition.id, entryPath: `src/components/${promotionName}.tsx`, exportName: promotionName }
      : { componentId: bound?.componentId ?? this.metadata.composition.id, entryPath: bound?.path ?? 'src/PreviewLogin.tsx', exportName: bound?.exportName ?? 'PreviewLogin' }
    const binding = {
      ...selectedBinding,
      registry: [{ ...selectedBinding, props: {}, slots: [] }],
    }
    if (validation === 'preview' && this.options.validatePreview) await this.options.validatePreview({ root: this.root, files: staged, binding })
    if (validation === 'documentation' && this.options.validateDocumentation) await this.options.validateDocumentation({ root: this.root, files: staged, changedPaths: files.map(file => file.path) })
    const validationAvailable = validation === 'documentation' ? Boolean(this.options.validateDocumentation) : Boolean(this.options.validatePreview)
    const validationName = validation === 'documentation' ? 'Documentation build' : 'Preview build'
    const validationDetail = validation === 'documentation' ? 'The staged documentation candidate built successfully.' : 'The preview adapter built the staged candidate successfully.'
    const change: PreparedChange = {
      id, approvalDigest: '', scope, summary, files,
      validation: [
        { name: 'Parse', status: 'passed', detail: 'Changed TSX and CSS parsed successfully.' },
        { name: 'Types', status: 'passed', detail: 'The staged source passed TypeScript diagnostics.' },
        { name: validationName, status: validationAvailable ? 'passed' : 'not-run', detail: validationAvailable ? validationDetail : `Connect a ${validation === 'documentation' ? 'documentation' : 'preview'} validator before saving.` },
      ],
    }
    change.approvalDigest = digest(change, inputs, this.metadata.composition)
    this.prepared.clear()
    this.prepared.set(id, { public: structuredClone(change), inputs, digest: change.approvalDigest, promotionName, consumed: false, reverseAction: reversal?.action === 'undo' ? 'redo' : 'undo', compositionBefore: structuredClone(this.metadata.composition), compositionAfter: null, targetComposition: reversal?.composition ?? null, promotedBinding: null, reverseBinding: reversal?.binding ?? null })
    this.conflict = null
    return structuredClone(change)
  }

  prepareLabelPadding(padding: string): Promise<PreparedChange> {
    return this.serial(async () => {
      await this.snapshot()
      this.assertWritable()
      const label = this.metadata.atoms.find(atom => atom.exportName === 'Label' && atom.kind === 'atom')
      if (!label) throw new Error('Label is not a discovered root atom')
      const before = await readOptional(this.root, label.path)
      if (before === null) throw new Error('Label source is missing')
      return this.prepare('Shared component', 'Change shared Label padding', [{ path: label.path, expectedBefore: before, after: patchLabelPadding(before, label.exportName, padding) }])
    })
  }

  prepareToken(value: string): Promise<PreparedChange> {
    return this.serial(async () => {
      await this.snapshot()
      const before = await readOptional(this.root, 'src/globals.css')
      if (before === null) throw new Error('The canonical globals.css file is missing')
      return this.prepare('Token', 'Change the accent token', [{ path: 'src/globals.css', expectedBefore: before, after: patchToken(before, value) }])
    })
  }

  preparePromotion(name: string): Promise<PreparedChange> {
    return this.serial(async () => {
      await this.snapshot()
      this.assertWritable()
      const preview = await readOptional(this.root, 'src/PreviewLogin.tsx')
      if (preview === null) throw new Error('The live preview composition source is missing')
      const file = await loadFile(this.root, this.metadata.projectId, this.metadata.atoms)
      const page = file?.pages[0]
      // Drawn primitives have no source representation yet; promoting only the components would silently drop them.
      if (file && page && pageNodes(file, page.id).some(id => file.nodes[id]?.type !== 'component')) throw new Error('Canvas layout needs a reviewed source adapter before promotion')
      const document = file && page ? legacyPageDocument(file, page.id) : null
      const documentChanged = document !== null && compositionContent(document) !== compositionContent(createDocument(this.metadata.atoms, this.metadata.composition))
      const relative = `src/components/${name}.tsx`
      const layoutStyles = file && page && documentChanged ? promotionLayoutStyles(file, page.id) : {}
      const output = document && documentChanged ? documentPromotionSource(name, document, this.metadata.atoms, relative, layoutStyles) : promotionSource(name, preview)
      if (await readOptional(this.root, relative) !== null) throw new Error('That component file already exists')
      const barrel = await readOptional(this.root, 'src/components/index.ts')
      const names = new Set(this.metadata.atoms.map(atom => atom.exportName))
      if (names.has(name)) throw new Error('That component export already exists')
      for (const required of ['Input', 'Button', 'Card', 'Label']) if (!names.has(required)) throw new Error(`Required atom ${required} is missing`)
      const summary = Object.keys(layoutStyles).length ? `Promote Login to ${name} with layout written as inline style props` : `Promote Login to ${name}`
      return this.prepare('Instance', summary, [{ path: relative, expectedBefore: null, after: output }, { path: 'src/components/index.ts', expectedBefore: barrel, after: appendExport(barrel ?? '', name) }], name)
    })
  }

  prepareBlumeDocs(catalog: ComponentDocsCatalog, examples: readonly BlumeComponentExample[], layout: Omit<BlumeComponentDocsLayout, 'navigationSource'>): Promise<PreparedChange> {
    return this.serial(async () => {
      await this.snapshot()
      const validated = planBlumeComponentDocs(catalog, examples, { ...layout, navigationSource: null })
      const navigationPath = validated.files.find(file => file.role === 'navigation')?.path
      if (!navigationPath) throw new Error('Blume navigation output is missing')
      const navigationSource = await readOptional(this.root, navigationPath)
      const plan = planBlumeComponentDocs(catalog, examples, { ...layout, navigationSource })
      const changes = await Promise.all(plan.files.map(async file => ({ path: file.path, expectedBefore: await readOptional(this.root, file.path), after: file.content })))
      return this.prepare('Shared component', 'Update component documentation', changes, null, undefined, 'documentation')
    })
  }

  savePrepared(id: string, approvalDigest: string): Promise<SaveResult> {
    return this.serial(async () => {
      const transaction = this.prepared.get(id)
      if (!transaction || transaction.consumed || transaction.digest !== approvalDigest || digest(transaction.public, transaction.inputs, this.metadata.composition) !== approvalDigest) throw new Error('Approval is missing, expired, or does not match this change')
      if (transaction.public.validation.some(check => check.status !== 'passed')) throw new Error('Complete preview build validation before saving')
      this.assertWritable()
      const sources = await this.transactionSources(transaction.public.files.map(file => file.path))
      const changes = changedPaths(transaction.inputs, await this.inputHashes(sources))
      if (changes.length) {
        transaction.consumed = true
        this.conflict = { kind: 'external-change', message: 'Source changed after review. Prepare and review a new change.', paths: changes }
        return { status: 'conflict', transactionId: id, message: this.conflict.message, snapshot: await this.snapshot() }
      }
      const lockPath = await confined(this.root, '.design-editor/source.lock')
      const lock = await open(lockPath, 'wx').catch(() => { throw new Error('Another source transaction is running') })
      const journal: Journal = { version: 1, id, status: 'writing', files: transaction.public.files, message: '' }
      const replaced: FileChange[] = []
      const metadataBefore = structuredClone(this.metadata)
      transaction.consumed = true
      try {
        const lockedInputs = await this.transactionSources(transaction.public.files.map(file => file.path))
        if (changedPaths(transaction.inputs, await this.inputHashes(lockedInputs)).length) throw new Error('Source changed while acquiring the transaction lock')
        await atomicText(this.root, '.design-editor/transaction.json', JSON.stringify(journal, null, 2))
        for (const file of transaction.public.files) {
          if (await readOptional(this.root, file.path) !== file.before) throw new Error('Source changed while saving')
          const destination = await confined(this.root, file.path)
          if (file.after === null) await unlink(destination)
          else await atomicText(this.root, file.path, file.after)
          replaced.push(file)
          await this.options.afterReplacement?.(replaced.length)
        }
        this.saved.set(id, transaction)
        if (transaction.promotionName) {
          await this.snapshot()
          const promoted = this.metadata.atoms.find(atom => atom.exportName === transaction.promotionName && atom.kind === 'component')
          if (!promoted) throw new Error('The promoted component could not be rebound')
          this.metadata.composition.componentId = promoted.componentId
          this.metadata.composition.name = transaction.promotionName
          transaction.promotedBinding = structuredClone(promoted)
        }
        if (transaction.targetComposition) {
          if (transaction.reverseBinding) {
            this.metadata.atoms = this.metadata.atoms.filter(atom => atom.componentId !== transaction.reverseBinding!.componentId)
            if (transaction.targetComposition.componentId === transaction.reverseBinding.componentId) this.metadata.atoms.push(structuredClone(transaction.reverseBinding))
          }
          this.metadata.composition = structuredClone(transaction.targetComposition)
          transaction.promotedBinding = transaction.reverseBinding
        }
        transaction.compositionAfter = structuredClone(this.metadata.composition)
        this.metadata.history = [...this.saved.values()]
        this.conflict = null
        const snapshot = await this.snapshot()
        journal.status = 'saved'
        await atomicText(this.root, '.design-editor/transaction.json', JSON.stringify(journal, null, 2))
        return { status: 'saved', transactionId: id, message: 'Changes saved to source.', snapshot }
      } catch (error) {
        this.saved.delete(id)
        let restored = true
        for (const file of [...replaced].reverse()) {
          try {
            if (await readOptional(this.root, file.path) !== file.after) throw new Error('External changes prevent automatic rollback')
            if (file.before === null) await unlink(await confined(this.root, file.path))
            else await atomicText(this.root, file.path, file.before)
          } catch { restored = false }
        }
        journal.status = restored ? 'rolled-back' : 'recovery-required'
        journal.message = error instanceof Error ? error.message : 'Source transaction failed'
        await atomicText(this.root, '.design-editor/transaction.json', JSON.stringify(journal, null, 2))
        if (restored) this.metadata = metadataBefore
        this.conflict = { kind: 'rollback', message: restored ? 'Save failed. Original source was restored.' : 'Save failed. External changes need manual recovery from the transaction journal.', paths: transaction.public.files.map(file => file.path) }
        return { status: 'rolled-back', transactionId: id, message: this.conflict.message, snapshot: await this.snapshot() }
      } finally {
        await lock.close()
        await unlink(lockPath)
      }
    })
  }

  private prepareReverse(transactionId: string, action: 'undo' | 'redo'): Promise<PreparedChange> {
    return this.serial(async () => {
      const transaction = this.saved.get(transactionId)
      if (!transaction || transaction.reverseAction !== action) throw new Error(`There is no saved transaction to ${action}`)
      if ([...this.saved.keys()].at(-1) !== transactionId) throw new Error('Review the latest source transaction first')
      for (const file of transaction.public.files) {
        if (await readOptional(this.root, file.path) !== file.after) {
          this.conflict = { kind: 'external-change', message: `Source changed after Save. ${action === 'undo' ? 'Undo' : 'Redo'} needs a new source review.`, paths: [file.path] }
          throw new Error(this.conflict.message)
        }
      }
      const changesBinding = transaction.compositionAfter?.componentId !== transaction.compositionBefore.componentId
      if (changesBinding && this.metadata.composition.componentId !== transaction.compositionAfter?.componentId) throw new Error('The composition binding changed. Refresh before reviewing source history.')
      const summary = transaction.public.summary.replace(/^(?:(?:Undo|Redo): )+/, '')
      return this.prepare(transaction.public.scope, `${action === 'undo' ? 'Undo' : 'Redo'}: ${summary}`, transaction.public.files.map(file => ({ path: file.path, expectedBefore: file.after, after: file.before })), null, { action, composition: changesBinding ? transaction.compositionBefore : null, binding: transaction.promotedBinding })
    })
  }

  prepareUndo(transactionId: string): Promise<PreparedChange> { return this.prepareReverse(transactionId, 'undo') }
  prepareRedo(transactionId: string): Promise<PreparedChange> { return this.prepareReverse(transactionId, 'redo') }

  confirmIdentity(componentId: string, candidate: string): Promise<ProjectSnapshot> {
    return this.serial(async () => {
      const old = this.metadata.atoms.find(atom => atom.componentId === componentId)
      if (!old || old.status !== 'ambiguous' || !old.candidates.includes(candidate)) throw new Error('Choose a current identity candidate')
      const current = discover(this.root, await sourceFiles(this.root)).find(atom => `${atom.path}#${atom.exportName}` === candidate && atom.fingerprint === old.fingerprint)
      if (!current) throw new Error('Identity evidence changed. Refresh and review again.')
      const documentState = await readDocumentState(this.root, this.metadata.projectId, this.metadata.atoms, { allowUnavailableBindings: true })
      Object.assign(old, current, { status: 'bound', candidates: [] })
      for (const child of this.metadata.composition.children) if (child.componentId === componentId) child.exportName = current.exportName
      if (documentState.file) {
        for (const node of Object.values(documentState.file.nodes)) if (node.type === 'component' && node.componentId === componentId) node.exportName = current.exportName
        await persistDocument(this.root, documentState.file, documentState.file.revision, this.metadata.atoms, documentState.hash)
      }
      this.prepared.clear()
      this.conflict = null
      return this.snapshot()
    })
  }
}

export const createRepoEngine = (root: string, options?: EngineOptions): Promise<RepoEngine> => RepoEngine.open(root, options)
export const createFixtureEngine = createRepoEngine
