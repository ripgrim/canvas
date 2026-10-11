import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Text } from '../../design-system/atoms'
import { EditorWorkArea, ShareDialogContent, editorColumns, toggleEditorPanel } from './Editor'
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
    expect(source).toMatch(/<PanelToolbar label=\{copy\.panelActions\}><CollaborationPresence \/><PanelToolbarActions>/)
  })
})
