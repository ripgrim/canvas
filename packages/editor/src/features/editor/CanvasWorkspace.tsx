import { useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button, Icon, Layout, Surface, Text } from '../../design-system/atoms'
import { CanvasChoice, CanvasFloatingActions, CanvasHudCanvas, CanvasPixelGrid, CanvasViewport, CanvasWorldOrigin, LiveCanvasPreview } from '../../design-system/canvas-atoms'
import { canvasCopy as copy } from './canvas-copy'
import { documentStore as store } from './document-store'
import { canvasViewportService } from './canvas-viewport-service'
import { canvasGestures } from './canvas-gestures'
import { canvasHudPainter } from './canvas-hud-painter'
import { gridBackground } from './canvas-math'
import { CanvasStage } from './CanvasStage'
import { SelectionHud } from './SelectionHud'
import { EditorToolRail, editorTools } from './ToolRail'
import type { EditorTool, EditorToolAvailability } from './ToolRail'
import { NodeContextMenu } from './NodeContextMenu'

export type CanvasWorkspaceProps = {
  src?: string | undefined
  ready?: boolean
  onReady: (target: Window | null) => void
  onError: () => void
  onShortcuts?: () => void
  placeholder?: ReactNode
  status?: { label: string; description?: string | undefined } | undefined
  /** The file's design preview theme and the themes its stylesheet declares. Independent of the editor appearance. */
  theme?: { value: string; options: { value: string; label: string }[]; onChange: (themeId: string) => void }
}

const attachViewport = (element: HTMLDivElement | null) => { canvasViewportService.attach(element); canvasGestures.attach(element) }
const attachHud = (element: HTMLCanvasElement | null) => canvasHudPainter.attach(element)

export function CanvasWorkspace({ src, ready = true, onReady, onError, onShortcuts, placeholder, status, theme }: CanvasWorkspaceProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const connected = Boolean(src && ready)
  const availability = Object.fromEntries(editorTools.map(tool => [tool, !state.file ? { available: false, reason: copy.openFileForTools } : !connected ? { available: false, reason: copy.connectPreviewForTools } : { available: true, reason: '' }])) as unknown as EditorToolAvailability
  const selectTool = (tool: EditorTool) => store.setTool(tool)
  const grid = gridBackground(state.viewport, state.viewportSize, typeof window === 'undefined' ? 1 : window.devicePixelRatio)
  return <Surface roleName="canvas-area" label={copy.preview}>
    <CanvasViewport label={copy.preview} attach={attachViewport}>
      {/* A fresh iframe per URL: changing src on a mounted iframe would push a joint history entry and break Back/Forward. */}
      {src && <LiveCanvasPreview key={src} src={src} title={copy.preview} onReady={onReady} onError={onError} />}
      <CanvasPixelGrid visible={state.gridVisible} size={grid.size} position={grid.position} lineWidth={grid.lineWidth} />
      <CanvasWorldOrigin camera={state.viewport} />
      <CanvasStage active={connected} onOpenContextMenu={setContextMenu} onDismissContextMenu={() => setContextMenu(null)} />
      {connected && <><CanvasHudCanvas attach={attachHud} /><SelectionHud /></>}
    </CanvasViewport>
    {(!src || !ready) && placeholder}
    <EditorToolRail active={state.tool} availability={availability} shortcuts={{ move: 'V', scale: 'K', hand: 'H', frame: 'F', shader: 'S', text: 'T', rectangle: 'R', shape: 'O', interact: 'I' }} onSelect={selectTool} />
    <CanvasFloatingActions label={copy.history}><Button label={copy.undo} title={copy.undoTip} disabled={!state.canUndo || state.blocked} onClick={() => store.undo()}><Icon name="undo" /></Button><Button label={copy.redo} title={copy.redoTip} disabled={!state.canRedo || state.blocked} onClick={() => store.redo()}><Icon name="redo" /></Button></CanvasFloatingActions>
    {contextMenu && <NodeContextMenu position={contextMenu} onClose={() => setContextMenu(null)} />}
    <Layout roleName="canvas-footer"><Layout roleName="canvas-footer-start"><Button label={copy.shortcuts} onClick={onShortcuts}>?</Button>{theme && <Layout roleName="preview-theme-control" title={copy.previewTheme}><Text roleName="small">{copy.previewThemeLabel}</Text><CanvasChoice label={copy.previewTheme} value={theme.value} options={theme.options} onChange={theme.onChange} disabled={theme.options.length < 2} /></Layout>}{status && <Layout roleName="canvas-runtime-status" role="status" aria-live="polite" title={status.description}><Text roleName="small">{status.label}</Text></Layout>}</Layout><Layout roleName="zoom-controls"><Button label={copy.zoomOut} onClick={() => store.zoomStep('out')}><Icon name="minus" /></Button><Button label={copy.fit} onClick={() => store.requestFit('all')}>{copy.percentage(state.viewport.zoom)}</Button><Button label={copy.zoomIn} onClick={() => store.zoomStep('in')}><Icon name="plus" /></Button></Layout></Layout>
  </Surface>
}
