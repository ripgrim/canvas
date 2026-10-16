import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createBlankFile } from '@canvas/repo-engine/file-document'
import { Text } from '../../design-system/atoms'
import { EditorWorkArea, ShareDialogContent, editorColumns, inspectorHeaderPresentation, toggleEditorPanel } from './Editor'
import type { EditorState } from './store'

describe('share access presentation', () => {
  it('AT-SHARE-003 offers Reload when access could not be confirmed', () => {
    const state = {
      mode: 'dark',
      shareBusy: false,
      shareAccess: null,
      shareDraft: 'view',
      shareError: 'Access could not be confirmed. Offline.',
    } as EditorState
    const html = renderToStaticMarkup(h(ShareDialogContent, { state }))
    expect(html).toContain('Access could not be confirmed. Offline.')
    expect(html).toContain('>Reload<')
    expect(html).not.toContain('>Only you<')
  })
})

describe('UI-COLLAB-FOLLOW-001 editor following shell', () => {
  it('hides side columns without unmounting their component state', () => {
    const html = renderToStaticMarkup(h(EditorWorkArea, {
      following: true,
      readOnly: false,
      columns: editorColumns({ left: 280, right: 300 }, false, true),
      library: h(Text, null, 'Library state'),
      canvas: h(Text, null, 'Canvas state'),
      inspector: h(Text, null, 'Inspector state'),
      leftResizer: h(Text, null, 'Left resize'),
      rightResizer: h(Text, null, 'Right resize'),
    }))
    expect(html).toContain('data-following="true"')
    expect(html).toContain('grid-template-columns:0 minmax(0, 1fr) 0')
    expect(html).toContain('Library state')
    expect(html).toContain('Inspector state')
    expect(html).not.toContain('Left resize')
    expect(html).not.toContain('Right resize')
  })

  it('restores the exact prior panel visibility after following stops', () => {
    const visibility = toggleEditorPanel({ left: true, right: true }, 'left')
    expect(visibility).toEqual({ left: false, right: true })
    expect(editorColumns({ left: 280, right: 300 }, false, false, visibility)).toBe('0 minmax(0, 1fr) 300px')
    expect(editorColumns({ left: 280, right: 300 }, false, true, visibility)).toBe('0 minmax(0, 1fr) 0')
    expect(editorColumns({ left: 280, right: 300 }, false, false, visibility)).toBe('0 minmax(0, 1fr) 300px')
    const html = renderToStaticMarkup(h(EditorWorkArea, {
      following: false, readOnly: false, visibility,
      columns: editorColumns({ left: 280, right: 300 }, false, false, visibility),
      library: h(Text, null, 'Library state'), canvas: h(Text, null, 'Canvas state'), inspector: h(Text, null, 'Inspector state'),
      leftResizer: h(Text, null, 'Left resize'), rightResizer: h(Text, null, 'Right resize'),
    }))
    expect(html).toContain('data-left-hidden="true"')
    expect(html).toContain('Library state')
    expect(html).not.toContain('Left resize')
    expect(html).toContain('Right resize')
  })
})

describe('UI-COLLAB-READONLY-001 editor read-only shell', () => {
  it('retains the library while removing the inspector and its reserved column', () => {
    const html = renderToStaticMarkup(h(EditorWorkArea, {
      following: false,
      readOnly: true,
      columns: editorColumns({ left: 260, right: 320 }, true, false),
      library: h(Text, null, 'Library state'),
      canvas: h(Text, null, 'Canvas state'),
      inspector: h(Text, null, 'Inspector state'),
      leftResizer: h(Text, null, 'Left resize'),
      rightResizer: h(Text, null, 'Right resize'),
    }))
    expect(html).toContain('data-read-only="true"')
    expect(html).toContain('grid-template-columns:260px minmax(0, 1fr) 0')
    expect(html).toContain('Library state')
    expect(html).not.toContain('Inspector state')
    expect(html).toContain('Left resize')
    expect(html).not.toContain('Right resize')
  })

  it('keeps the layers section mounted in read-only mode', () => {
    const source = readFileSync(new URL('./Editor.tsx', import.meta.url), 'utf8')
    expect(source).toContain('<DocumentLayers readOnly={document.readOnly} />')
    expect(source).not.toContain('!document.readOnly && <SidebarSection id="layers"')
  })

  it('does not mount the retired components library', () => {
    const source = readFileSync(new URL('./Editor.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain('ComponentLibrary')
    expect(source).not.toContain('id="components"')
    expect(source).not.toContain("components: false")
  })

  it('COMP-V2-UI-001 exposes the unified Kit view and model inspector', () => {
    const source = readFileSync(new URL('./Editor.tsx', import.meta.url), 'utf8')
    expect(source).toContain("type SidebarView = 'design' | 'theme' | 'kit' | 'sources'")
    expect(source).toContain("<ComponentKitPanel atoms={atoms} onOpenCanvas={() => setView('design')} />")
    expect(source).toContain('<ComponentCreationDialog />')
    expect(source).toContain('? <ComponentModelProperties />')
    expect(source).not.toContain('<ComponentMasterProperties componentId=')
    expect(source).toContain('<>{componentInspector}<SelectionInspector /></>')
    expect(source).toContain('inspectorHeaderPresentation(document.file, document.selection, document.pageId)')
    expect(source).not.toContain('selectedChild?.componentId')
    expect(source).not.toContain('atoms.find(atom => atom.componentId')
    expect(readFileSync(new URL('./InspectorPanels.tsx', import.meta.url), 'utf8')).toContain('Boolean(canvasComponentNode(file, primitives[0]!.id))')
    expect(source).not.toContain('id="components"')
  })

  it('COMP-V2-UI-062 exposes source review only for a prepared transaction', () => {
    const source = readFileSync(new URL('./Editor.tsx', import.meta.url), 'utf8')
    const shortcuts = readFileSync(new URL('./copy.ts', import.meta.url), 'utf8')
    expect(source).toContain('!readOnly && state.prepared && <HeaderIconButton compact label={copy.review}')
    expect(source).toContain('state.reviewOpen && state.prepared && !document.readOnly && <SourceReview')
    expect(shortcuts).not.toContain("['Review changes', 'Ctrl / Cmd + S']")
    expect(shortcuts).toContain("['Reload file', 'Ctrl / Cmd + Shift + R']")
  })

  it('COMP-V2-UI-063 keeps component inventory separate from repository lifecycle', () => {
    const editor = readFileSync(new URL('./Editor.tsx', import.meta.url), 'utf8')
    const kit = readFileSync(new URL('./ComponentKitPanel.tsx', import.meta.url), 'utf8')
    const repository = readFileSync(new URL('./ComponentRepositoryPanel.tsx', import.meta.url), 'utf8')
    expect(kit).toContain('<ComponentKitSection title={copy.components}>{content}</ComponentKitSection>')
    expect(kit).not.toContain('ComponentRepositoryPanel')
    expect(kit).not.toContain('hostedRepositoryService')
    expect(kit).not.toContain('RepositoryDocsReviewDialog')
    expect(editor).toContain("{ value: 'sources', label: sidebarCopy.sources }")
    expect(editor).toContain('<SidebarTabPanel idPrefix="sidebar" value="sources"><ComponentRepositoryPanel /></SidebarTabPanel>')
    expect(repository).toContain('<ComponentKitSection title={copy.repository}>')
    expect(repository).toContain('hostedRepositoryService.saveDocs()')
  })
})

describe('AT-PERF-001 collaboration render isolation', () => {
  it('subscribes the editor shell only to the primitive following state', () => {
    const source = readFileSync(new URL('./Editor.tsx', import.meta.url), 'utf8')
    expect(source).toContain('collaborationService.subscribeFollowing')
    expect(source).not.toContain('useSyncExternalStore(collaborationService.subscribe, collaborationService.getSnapshot')
  })
})

describe('UI-COLLAB-PRESENCE-001 inspector header placement', () => {
  it('mounts the identity strip before the right-aligned panel actions', () => {
    const source = readFileSync(new URL('./Editor.tsx', import.meta.url), 'utf8')
    expect(source).toMatch(/<PanelToolbar label=\{copy\.panelActions\}>.*<CollaborationPresence \/><PanelToolbarActions>/)
  })
})

describe('UI-DESKTOP-SHELL-001 Paper-style canvas chrome', () => {
  it('keeps panel controls in their inner headers and recovery controls at collapsed edges', () => {
    const editor = readFileSync(new URL('./Editor.tsx', import.meta.url), 'utf8')
    const canvas = readFileSync(new URL('./CanvasWorkspace.tsx', import.meta.url), 'utf8')

    expect(editor).toMatch(/PanelHeaderActions><HeaderIconButton label=\{canvasCopy\.hideLayers\}/)
    expect(editor).toMatch(/PanelToolbar label=\{copy\.panelActions\}><HeaderIconButton compact label=\{canvasCopy\.hideProperties\}/)
    expect(canvas).toContain('canvas-panel-reveal-left')
    expect(canvas).toContain('canvas-panel-reveal-right')
  })

  it('COMP-V2-UI-054 identifies component masters and instances in the inspector header', () => {
    const editor = readFileSync(new URL('./Editor.tsx', import.meta.url), 'utf8')
    expect(editor).toContain("<PanelHeader title={presentation.title} {...(presentation.component ? { icon: 'component' as const } : {})} />")
  })

  it('COMP-V2-UI-061 derives component identity only from the semantic model', () => {
    const blank = createBlankFile('inspector-identity', 'page', 'root', 'Page')
    const ordinaryCodeNode = {
      id: 'code-node', type: 'component' as const, name: 'Unreconciled button', componentId: 'source-button', exportName: 'Button', props: {},
    }
    const ordinary = {
      ...blank,
      nodes: { ...blank.nodes, [ordinaryCodeNode.id]: ordinaryCodeNode },
      relationships: { ...blank.relationships, [ordinaryCodeNode.id]: { parentId: 'root', index: 0, orderKey: 'a' } },
    }
    expect(inspectorHeaderPresentation(ordinary, [ordinaryCodeNode.id], 'page')).toEqual({ title: 'Unreconciled button', component: false })

    const semantic = {
      ...ordinary,
      componentModel: {
        definitions: {
          button: { id: 'button', name: 'Semantic button', source: { kind: 'code' as const, bindingId: 'source-button' }, revision: 0, properties: [], materials: [], parts: [], interactions: [] },
        },
        instances: { [ordinaryCodeNode.id]: { id: ordinaryCodeNode.id, componentId: 'button', values: {} } },
      },
    }
    expect(inspectorHeaderPresentation(semantic, [ordinaryCodeNode.id], 'page')).toEqual({ title: 'Semantic button', component: true })
    expect(inspectorHeaderPresentation(semantic, [], 'page')).toEqual({ title: 'Page', component: false })
    expect(inspectorHeaderPresentation(semantic, ['code-node', 'missing'], 'page')).toEqual({ title: '2 selected', component: false })
  })

  it('reserves a real tool column and removes persistent footer clutter', () => {
    const editor = readFileSync(new URL('./Editor.tsx', import.meta.url), 'utf8')
    const canvas = readFileSync(new URL('./CanvasWorkspace.tsx', import.meta.url), 'utf8')
    const styles = readFileSync(new URL('../../design-system/styles.css', import.meta.url), 'utf8')
    const tools = readFileSync(new URL('../../design-system/tool-rail.css', import.meta.url), 'utf8')

    expect(canvas).toContain('roleName="canvas-tool-column"')
    expect(canvas).toContain('roleName="canvas-footer"')
    expect(canvas).toContain('roleName="zoom-controls"')
    expect(canvas).not.toContain('preview-theme-control')
    expect(editor).not.toContain('copy.compositionStatus')
    expect(styles).toMatch(/grid-template-columns: 48px minmax\(0, 1fr\)/)
    expect(tools).toMatch(/\.canvas-tool-column \{[^}]*grid-column: 1;[^}]*grid-row: 1 \/ 3;/)
  })
})
