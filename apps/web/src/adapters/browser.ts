import { createDocument } from '@canvas/repo-engine/document'
import type { Atom, Composition } from '@canvas/repo-engine/contracts'
import type { FileDocument } from '@canvas/repo-engine/file-document'
import { UnavailableCapabilityError } from '@canvas/editor/capabilities'
import type { EditorCapabilities, EditorProjectApi, EditorProjectSnapshot } from '@canvas/editor/capabilities'
import { designThemesFromTokens, extractCssTokens } from '@canvas/repo-engine/design-themes'
import sampleStylesheet from '../../../../tests/fixtures/component-repo-seed/src/globals.css?raw'
import { createBrowserFileService, migratedBrowserFileId } from '../features/files/service'
import type { BrowserFileLocks, BrowserFileStorage, BrowserOpenedFile, LegacyView } from '../features/files/service'

export type BrowserDraftStorage = BrowserFileStorage
export type BrowserDraftLocks = BrowserFileLocks

export const browserDraftKey = 'design-editor.browser-draft.v1'
const sourceReason = 'Source editing needs a connected repository. This draft stays in this browser.'

const atom = (name: 'Button' | 'Card' | 'Input' | 'Label', props: Atom['props']): Atom => ({
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
})

const sampleAtoms: Atom[] = [
  atom('Button', [
    { name: 'children', type: 'ReactNode', optional: true },
    { name: 'variant', type: '"primary" | "quiet" | undefined', optional: true },
    { name: 'type', type: '"button" | "submit" | "reset" | undefined', optional: true },
    { name: 'disabled', type: 'boolean | undefined', optional: true },
  ]),
  atom('Card', [
    { name: 'children', type: 'ReactNode', optional: true },
    { name: 'heading', type: 'ReactNode', optional: true },
    { name: 'footer', type: 'ReactNode', optional: true },
    { name: 'id', type: 'string | undefined', optional: true },
  ]),
  atom('Input', [
    { name: 'id', type: 'string | undefined', optional: true },
    { name: 'name', type: 'string | undefined', optional: true },
    { name: 'type', type: 'HTMLInputTypeAttribute | undefined', optional: true },
    { name: 'placeholder', type: 'string | undefined', optional: true },
    { name: 'disabled', type: 'boolean | undefined', optional: true },
    { name: 'required', type: 'boolean | undefined', optional: true },
    { name: 'maxLength', type: 'number | undefined', optional: true },
  ]),
  atom('Label', [
    { name: 'children', type: 'ReactNode', optional: true },
    { name: 'htmlFor', type: 'string | undefined', optional: true },
    { name: 'id', type: 'string | undefined', optional: true },
  ]),
]
export const browserSampleAtoms: Atom[] = structuredClone(sampleAtoms)
/** The bundled sample's own stylesheet declares its themes: the root palette and its `data-theme` modes. */
const sampleTokens = extractCssTokens(sampleStylesheet, 'src/globals.css')
export const browserSampleThemes = designThemesFromTokens(sampleTokens)

const composition: Composition = {
  id: 'browser-local-composition',
  name: 'Local draft',
  componentId: null,
  children: [
    { id: 'sample-instance-label-email', componentId: 'sample-label', exportName: 'Label', props: { htmlFor: 'email', children: 'Email' } },
    { id: 'sample-instance-input-email', componentId: 'sample-input', exportName: 'Input', props: { id: 'email', type: 'email', placeholder: 'you@example.com' } },
    { id: 'sample-instance-label-password', componentId: 'sample-label', exportName: 'Label', props: { htmlFor: 'password', children: 'Password' } },
    { id: 'sample-instance-input-password', componentId: 'sample-input', exportName: 'Input', props: { id: 'password', type: 'password' } },
    { id: 'sample-instance-button', componentId: 'sample-button', exportName: 'Button', props: { children: 'Sign in', variant: 'primary' } },
  ],
}

export const browserSampleComposition = structuredClone(composition)

export const browserCapabilities: EditorCapabilities = {
  runtime: 'browser',
  openLabel: 'Open local draft',
  files: {
    list: { available: true, reason: 'Local files are stored in this browser.' },
    create: { available: true, reason: 'Create a local file in this browser.' },
    open: { available: true, reason: 'Open a local file from this browser.' },
  },
  sourceWrites: { available: false, reason: sourceReason },
  localRepository: { available: false, reason: 'Local repository connection is unavailable in this browser draft.' },
  hostedExecution: { available: false, reason: 'This browser draft previews trusted bundled samples only.' },
  git: { available: false, reason: 'Git import needs a connected project.' },
  mcp: { available: false, reason: 'MCP tools are not connected to this draft.' },
  hostedProjects: { available: false, reason: 'This draft is stored in this browser only.' },
}

function origin(value: string, label: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`${label} must be an HTTP or HTTPS origin`) }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) throw new Error(`${label} must be an HTTP or HTTPS origin`)
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error(`${label} must use HTTPS outside loopback`)
  return url.origin
}

/** Snapshot plus the view state a migrated legacy file carried, so the editor can seed its own view state once. */
export type BrowserProjectSnapshot = EditorProjectSnapshot & { legacyView?: LegacyView }
type SnapshotMethods = 'openFile' | 'openProject' | 'refresh' | 'saveFile'
export type BrowserProjectApi = Omit<EditorProjectApi, SnapshotMethods> & Readonly<{
  openFile(fileId: string): Promise<BrowserProjectSnapshot>
  openProject(): Promise<BrowserProjectSnapshot>
  refresh(): Promise<BrowserProjectSnapshot>
  saveFile(file: FileDocument, expectedRevision: number): Promise<BrowserProjectSnapshot>
}>

export function createBrowserAdapter(storage: BrowserDraftStorage, previewOrigin?: string, editorOrigin?: string, locks?: BrowserDraftLocks): BrowserProjectApi {
  const preview = previewOrigin === undefined ? null : origin(previewOrigin, 'Preview origin')
  const editor = editorOrigin === undefined ? null : origin(editorOrigin, 'Editor origin')
  if (preview && !editor) throw new Error('Editor origin is required for the browser preview')
  if (preview && preview === editor) throw new Error('Preview must use a separate origin')
  const fileService = createBrowserFileService({ storage, ...(locks ? { locks } : {}), atoms: sampleAtoms, legacyDraftKey: browserDraftKey })
  const capabilities: EditorCapabilities = locks ? browserCapabilities : {
    ...browserCapabilities,
    files: { ...browserCapabilities.files, create: { available: false, reason: 'This browser cannot safely create concurrent local files.' } },
  }
  let activeFileId: string | null = null
  const sampleInstanceIds = new Set(Object.keys(createDocument(sampleAtoms, composition).nodes))
  const snapshot = ({ name, file, legacyView }: BrowserOpenedFile): BrowserProjectSnapshot => {
    // Only the migrated sample draft is bound to the bundled login source; every other file renders its own nodes.
    const compositionPreview = !Object.values(file.nodes).some(node => node.type === 'component' && sampleInstanceIds.has(node.id))
    return {
      projectId: file.fileId,
      fileId: file.fileId,
      atoms: structuredClone(sampleAtoms),
      sourceHashes: {},
      composition: { ...structuredClone(composition), name, ...(compositionPreview ? { children: [] } : {}) },
      file,
      sourceHistory: [],
      conflict: null,
      phases: [{ name: 'Bundled sample loaded', completed: 1 }],
      tokens: structuredClone(sampleTokens),
      designThemes: structuredClone(browserSampleThemes),
      preview: preview && editor ? {
        status: 'ready', currentGeneration: 1, activeGeneration: 1, origin: preview,
        url: `${preview}/?generation=1&editorOrigin=${encodeURIComponent(editor)}&file=${encodeURIComponent(file.fileId)}${compositionPreview ? '&mode=composition' : ''}`,
        stale: false, diagnostics: [],
      } : {
        status: 'stopped', currentGeneration: 0, activeGeneration: null, origin: null,
        url: null, stale: false, diagnostics: ['The bundled sample preview is not running.'],
      },
      ...(legacyView ? { legacyView } : {}),
    }
  }
  const openFile = async (fileId: string) => {
    const opened = await fileService.open(fileId)
    activeFileId = opened.file.fileId
    return snapshot(opened)
  }
  const openProject = async () => {
    const files = await fileService.list()
    const target = files.find(file => file.id === migratedBrowserFileId) ?? files[0]
    if (!target) throw new UnavailableCapabilityError('Create a local file first')
    return openFile(target.id)
  }
  const unavailable = async (): Promise<never> => { throw new UnavailableCapabilityError(sourceReason) }
  return {
    capabilities,
    listFiles: () => fileService.list(),
    createFile: () => fileService.create(),
    openFile,
    openProject,
    refresh: () => activeFileId ? openFile(activeFileId) : openProject(),
    saveFile: async (file, expectedRevision) => {
      if (!activeFileId) throw new Error('Open a local file before saving it')
      if (!locks) throw new UnavailableCapabilityError('This browser cannot safely save concurrent edits.')
      return snapshot(await fileService.save(activeFileId, file, expectedRevision))
    },
    prepareLabelPadding: unavailable,
    prepareToken: unavailable,
    preparePromotion: unavailable,
    prepareUndo: unavailable,
    prepareRedo: unavailable,
    savePrepared: unavailable,
  }
}
