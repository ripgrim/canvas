import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react'
import { Icon } from './atoms'
import type { IconName } from './atoms'
import './canvas.css'

type Camera = { x: number; y: number; zoom: number }
type ScreenRect = { x: number; y: number; width: number; height: number }
type PointerHandlers<T extends HTMLElement> = { onPointerDown: (event: PointerEvent<T>) => void; onPointerMove: (event: PointerEvent<T>) => void; onPointerUp: (event: PointerEvent<T>) => void; onPointerCancel: (event: PointerEvent<T>) => void }

/** The page workspace. It owns the camera; the live preview, grid, interaction layer, and HUD are stacked inside it. */
export function CanvasViewport({ children, label, attach }: { children: ReactNode; label: string; attach: (element: HTMLDivElement | null) => void }) {
  return <div className="canvas-viewport" role="region" tabIndex={-1} aria-label={label} ref={attach}>{children}</div>
}

/** Camera transform marker for the world origin. Carries no size, paints nothing, and takes no pointer events. */
export function CanvasWorldOrigin({ camera }: { camera: Camera }) {
  return <div className="canvas-world" aria-hidden="true" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }} />
}

export function CanvasPixelGrid({ visible, size, position, lineWidth }: { visible: boolean; size: string; position: string; lineWidth: string }) {
  return <div className="canvas-pixel-grid" aria-hidden="true" data-visible={visible || undefined} style={{ backgroundSize: size, backgroundPosition: position, '--grid-line': lineWidth } as CSSProperties} />
}

export function LiveCanvasPreview({ src, title, onReady, onError }: { src: string; title: string; onReady: (target: Window | null) => void; onError: () => void }) {
  return <iframe className="live-canvas-preview" src={src} title={title} sandbox="allow-scripts allow-same-origin allow-forms" referrerPolicy="no-referrer" onLoad={event => onReady(event.currentTarget.contentWindow)} onError={onError} />
}

export type StageCursor = 'default' | 'crosshair' | 'grab' | 'grabbing' | 'move'
export function CanvasStageSurface({ label, cursor, inactive, onDoubleClick, onKeyDown, ...handlers }: PointerHandlers<HTMLDivElement> & { label: string; cursor: StageCursor; inactive: boolean; onDoubleClick: (event: React.MouseEvent<HTMLDivElement>) => void; onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void }) {
  return <div className="canvas-stage" role="application" tabIndex={-1} aria-label={label} data-cursor={cursor} data-inactive={inactive || undefined} onDoubleClick={onDoubleClick} onKeyDown={onKeyDown} {...handlers} />
}

export function CanvasHud({ children }: { children: ReactNode }) { return <div className="canvas-hud" aria-hidden="true">{children}</div> }

/** The 2D overlay every outline, marquee, guide and handle visual is painted on. Pointer events pass through it. */
export function CanvasHudCanvas({ attach }: { attach: (element: HTMLCanvasElement | null) => void }) {
  return <canvas className="canvas-hud-canvas" aria-hidden="true" ref={attach} />
}

export function CanvasFloatingActions({ children, label }: { children: ReactNode; label: string }) { return <div className="canvas-floating-actions" role="toolbar" aria-label={label}>{children}</div> }

export type HandleName = 'top-left' | 'top' | 'top-right' | 'right' | 'bottom-right' | 'bottom' | 'bottom-left' | 'left'
const handlePositions: Record<HandleName, { left: string; top: string; cursor: string }> = {
  'top-left': { left: '0%', top: '0%', cursor: 'nwse-resize' }, top: { left: '50%', top: '0%', cursor: 'ns-resize' }, 'top-right': { left: '100%', top: '0%', cursor: 'nesw-resize' }, right: { left: '100%', top: '50%', cursor: 'ew-resize' },
  'bottom-right': { left: '100%', top: '100%', cursor: 'nwse-resize' }, bottom: { left: '50%', top: '100%', cursor: 'ns-resize' }, 'bottom-left': { left: '0%', top: '100%', cursor: 'nesw-resize' }, left: { left: '0%', top: '50%', cursor: 'ew-resize' },
}
/** Four visible corner squares plus invisible edge zones, all screen-sized regardless of zoom. */
export function ResizeHandles({ id, rect, labelFor, handles, onHandlePointerDown, onPointerMove, onPointerUp, onPointerCancel }: { id: string; rect: ScreenRect; labelFor: (handle: HandleName) => string; handles: readonly HandleName[]; onHandlePointerDown: (event: PointerEvent<HTMLButtonElement>, handle: HandleName) => void; onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void; onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void; onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void }) {
  return <div className="resize-handles" data-handles-for={id} style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
    {handles.map(handle => <button key={handle} type="button" className="resize-handle" data-handle={handle} data-edge={handle.includes('-') ? undefined : 'true'} aria-label={labelFor(handle)} tabIndex={-1} style={{ left: handlePositions[handle].left, top: handlePositions[handle].top, cursor: handlePositions[handle].cursor }} onPointerDown={event => onHandlePointerDown(event, handle)} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} />)}
  </div>
}

export function NodeLabel({ id, rect, name, selected, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onDoubleClick }: PointerHandlers<HTMLButtonElement> & { id: string; rect: ScreenRect; name: string; selected: boolean; onDoubleClick: () => void }) {
  return <button type="button" className="node-label node-label-hit" data-node-label={id} data-selected={selected || undefined} tabIndex={-1} title={name} style={{ left: rect.x, top: rect.y, width: Math.max(48, rect.width) }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onDoubleClick={onDoubleClick}>{name}</button>
}

export function NodeLabelEditor({ id, rect, value, label, multiline, onCommit, onCancel }: { id: string; rect: ScreenRect; value: string; label: string; multiline: boolean; onCommit: (value: string) => void; onCancel: () => void }) {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    event.stopPropagation()
    if (event.key === 'Enter' && !(multiline && event.shiftKey)) { event.preventDefault(); onCommit(event.currentTarget.value) }
    if (event.key === 'Escape') { event.preventDefault(); onCancel() }
  }
  const shared = { className: 'node-label-editor', 'aria-label': label, 'data-editing': id, defaultValue: value, autoFocus: true, maxLength: multiline ? 10000 : 128, onKeyDown, onBlur: (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => onCommit(event.currentTarget.value), onFocus: (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => event.currentTarget.select() }
  if (multiline) return <textarea {...shared} style={{ left: rect.x, top: rect.y, width: Math.max(80, rect.width), height: Math.max(24, rect.height) }} />
  return <input {...shared} type="text" style={{ left: rect.x, top: rect.y, width: Math.max(80, rect.width) }} />
}

export function DimensionBadge({ rect, children }: { rect: ScreenRect; children: ReactNode }) {
  return <span className="dimension-badge" style={{ left: rect.x + rect.width / 2, top: rect.y + rect.height }}>{children}</span>
}


export function DocumentTree({ children, label }: { children: ReactNode; label: string }) {
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'))
    const current = items.indexOf(event.target as HTMLElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
    event.preventDefault()
    items[next]?.focus()
  }
  return <div role="tree" aria-label={label} aria-multiselectable="true" className="document-tree" onKeyDown={navigate}>{children}</div>
}

export function DocumentLayerItem({ name, toggleLabel, id, depth, selected, childrenCount, expanded, icon = 'component', onSelect, onToggle, onDrop, onRename, children }: { name: string; toggleLabel: string; id: string; depth: number; selected: boolean; childrenCount: number; expanded: boolean; icon?: IconName; onSelect: (modifiers: { additive: boolean; range: boolean }) => void; onToggle: () => void; onDrop: (nodeId: string) => void; onRename?: () => void; children: ReactNode }) {
  return <div className="document-layer-branch">
    <div className="document-layer-item" role="treeitem" tabIndex={0} aria-label={name} aria-level={depth + 1} aria-selected={selected} aria-expanded={childrenCount ? expanded : undefined} data-selected={selected || undefined} data-active={selected ? 'true' : undefined} data-instance-id={id} data-layer-node-id={id} style={{ '--layer-depth': depth } as CSSProperties} draggable onDragStart={event => { event.dataTransfer.setData('application/x-design-editor-node', id); event.dataTransfer.effectAllowed = 'move' }} onDragOver={event => { if (event.dataTransfer.types.includes('application/x-design-editor-node')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }} onDrop={event => { event.preventDefault(); const nodeId = event.dataTransfer.getData('application/x-design-editor-node'); if (nodeId) onDrop(nodeId) }} onClick={event => onSelect({ additive: event.ctrlKey || event.metaKey, range: event.shiftKey })} onDoubleClick={event => { event.stopPropagation(); onRename?.() }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect({ additive: event.ctrlKey || event.metaKey, range: event.shiftKey }) } if (event.key === 'F2' && onRename) { event.preventDefault(); onRename() } if (childrenCount && (event.key === 'ArrowRight' && !expanded || event.key === 'ArrowLeft' && expanded)) { event.preventDefault(); onToggle() } }}>
      {childrenCount ? <button type="button" className="layer-toggle" data-expanded={expanded || undefined} aria-label={toggleLabel} tabIndex={-1} onClick={event => { event.stopPropagation(); onToggle() }}><Icon name="chevron" /></button> : <span className="layer-toggle" aria-hidden="true" />}
      <span className="document-layer-icon" aria-hidden="true"><Icon name={icon} /></span>
      <span className="document-layer-name">{name}</span>
    </div>
    {expanded && children}
  </div>
}

export function DocumentSlotTarget({ label, depth, onDrop, children }: { label: string; depth: number; onDrop: (nodeId: string) => void; children: ReactNode }) {
  return <div className="document-slot" role="group" aria-label={label} style={{ '--layer-depth': depth } as CSSProperties} onDragOver={event => { if (event.dataTransfer.types.includes('application/x-design-editor-node')) event.preventDefault() }} onDrop={event => { event.stopPropagation(); event.preventDefault(); const id = event.dataTransfer.getData('application/x-design-editor-node'); if (id) onDrop(id) }}><span className="document-slot-label">{label}</span>{children}</div>
}

export function CanvasChoice({ label, value, options, onChange, disabled }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean }) {
  return <span className="canvas-choice-control"><select className="input canvas-choice" aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><Icon name="chevron" /></span>
}
