import type { DesignTheme } from './design-themes.js'
import type { FileDocument } from './file-document.js'
import type { EditorDocument } from './document.js'

export type BindingStatus = 'bound' | 'missing' | 'ambiguous'
export type ComponentBinding = {
  componentId: string
  path: string
  exportName: string
  fingerprint: string
  sourceHash: string
  status: BindingStatus
  candidates: string[]
}
export type Atom = ComponentBinding & {
  name: string
  kind: 'atom' | 'component'
  props: { name: string; type: string; optional: boolean }[]
}
export type Composition = {
  id: string
  name: string
  componentId: string | null
  children: { id: string; componentId: string; exportName: string; props: Record<string, string | boolean> }[]
}
export type Conflict = { kind: 'external-change' | 'identity' | 'rollback'; message: string; paths: string[] }
export type ProjectSnapshot = {
  projectId: string
  atoms: Atom[]
  sourceHashes: Record<string, string>
  composition: Composition
  /** The authoritative design file: pages, nodes, relationships, and the file theme. */
  file: FileDocument
  sourceHistory: { transactionId: string; summary: string; action: 'undo' | 'redo' }[]
  conflict: Conflict | null
  phases: { name: string; completed: number }[]
  tokens: { name: string; value: string; path: string; selector: string }[]
  /** Theme modes the design's stylesheet declares. Independent of the editor's appearance. */
  designThemes?: DesignTheme[]
}
export type FileChange = { path: string; before: string | null; after: string | null; diff: string }
export type Validation = { name: string; status: 'passed' | 'not-run'; detail: string }
export type PreparedChange = {
  id: string
  approvalDigest: string
  scope: 'Shared component' | 'Token' | 'Instance'
  summary: string
  files: FileChange[]
  validation: Validation[]
}
export type SaveResult = {
  status: 'saved' | 'conflict' | 'rolled-back'
  transactionId: string
  message: string
  snapshot: ProjectSnapshot
}
export type EngineOptions = {
  afterReplacement?: (index: number) => void | Promise<void>
  validatePreview?: (input: { root: string; files: Record<string, string>; binding: { componentId: string; entryPath: string; exportName: string } }) => Promise<void>
}
