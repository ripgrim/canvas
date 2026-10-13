import { useRef, useState } from 'react'
import type { CSSProperties, DragEvent, KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from 'react'
import type { CornerRadiusKey } from '@canvas/repo-engine/appearance'
import { Icon } from './atoms'
import type { IconName } from './atoms'
import { AppearanceVisibilityButton } from './appearance-atoms'
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
export function CanvasStageSurface({ label, cursor, inactive, onDoubleClick, onContextMenu, onKeyDown, onDragOver, onDrop, ...handlers }: PointerHandlers<HTMLDivElement> & { label: string; cursor: StageCursor; inactive: boolean; onDoubleClick: (event: React.MouseEvent<HTMLDivElement>) => void; onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void; onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void; onDragOver?: (event: DragEvent<HTMLDivElement>) => void; onDrop?: (event: DragEvent<HTMLDivElement>) => void }) {
  return <div className="canvas-stage" role="application" tabIndex={-1} aria-label={label} data-cursor={cursor} data-inactive={inactive || undefined} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu} onKeyDown={onKeyDown} onDragOver={onDragOver} onDrop={onDrop} {...handlers} />
}

export function CanvasHud({ children, generation }: { children: ReactNode; generation?: number }) { return <div className="canvas-hud" data-hud-generation={generation}>{children}</div> }

/** The 2D overlay every outline, marquee, guide and handle visual is painted on. Pointer events pass through it. */
export function CanvasHudCanvas({ attach }: { attach: (element: HTMLCanvasElement | null) => void }) {
  return <canvas className="canvas-hud-canvas" aria-hidden="true" ref={attach} />
}

export function CanvasFloatingActions({ children, label }: { children: ReactNode; label: string }) { return <div className="canvas-floating-actions" role="toolbar" aria-label={label}>{children}</div> }

export function MobileCanvasHeader({ children }: { children: ReactNode }) { return <div className="mobile-canvas-header">{children}</div> }

export function MobileCanvasToolbar({ children }: { children: ReactNode }) { return <div className="mobile-canvas-toolbar">{children}</div> }

export function MobileCanvasPanelToggle({ label, active, icon, onClick }: { label: string; active: boolean; icon: IconName; onClick: () => void }) {
  return <button type="button" className="mobile-canvas-panel-toggle" aria-label={label} title={label} aria-pressed={active} onClick={onClick}><Icon name={icon} /></button>
}

export function MobileSelectionActions({ children, label, position, phase, visible, generation }: { children: ReactNode; label: string; position: { x: number; y: number }; phase: 'idle' | 'moving' | 'resizing'; visible: boolean; generation?: number }) { return <div className="mobile-selection-actions" role="toolbar" aria-label={label} aria-hidden={!visible || undefined} inert={!visible ? true : undefined} data-phase={phase} data-visible={visible || undefined} data-hud-generation={generation} style={{ '--mobile-quick-actions-x': `${position.x}px`, '--mobile-quick-actions-y': `${position.y}px` } as CSSProperties}>{children}</div> }

export type HandleName = 'top-left' | 'top' | 'top-right' | 'right' | 'bottom-right' | 'bottom' | 'bottom-left' | 'left'
export type RotationHandleName = 'top-left' | 'top-right' | 'bottom-right' | 'bottom-left'
export type ResizeHandlePose = Readonly<{ handle: HandleName; center: Readonly<{ x: number; y: number }>; angle: number; cursor: CSSProperties['cursor']; active: boolean }>
export type RotationHandlePose = Readonly<{ handle: RotationHandleName; center: Readonly<{ x: number; y: number }> }>
export type CornerRadiusHandlePose = Readonly<{ corner: CornerRadiusKey; center: Readonly<{ x: number; y: number }>; angle: number; active: boolean }>
/** Literal projected point/edge targets. Visible squares remain on Canvas2D; DOM supplies screen-sized interaction zones. */
export function ResizeHandles({ id, generation, labelFor, poses, onHandlePointerDown, onHandleDoubleClick, onPointerMove, onPointerUp, onPointerCancel }: { id: string; generation: number; labelFor: (handle: HandleName) => string; poses: readonly ResizeHandlePose[]; onHandlePointerDown: (event: PointerEvent<HTMLButtonElement>, handle: HandleName) => void; onHandleDoubleClick?: (event: MouseEvent<HTMLButtonElement>, handle: HandleName) => void; onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void; onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void; onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void }) {
  return <div className="resize-handles" data-handles-for={id} data-hud-generation={generation}>
    {poses.map(pose => <button key={pose.handle} type="button" className="resize-handle" data-handle={pose.handle} data-edge={pose.handle.includes('-') ? undefined : 'true'} data-active={pose.active || undefined} aria-label={labelFor(pose.handle)} tabIndex={-1} style={{ left: pose.center.x, top: pose.center.y, cursor: pose.cursor, transform: `translate(-50%, -50%) rotate(${pose.angle}rad)` }} onPointerDown={event => onHandlePointerDown(event, pose.handle)} onDoubleClick={event => onHandleDoubleClick?.(event, pose.handle)} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} />)}
  </div>
}

/** Corner-adjacent rotation targets. The painted outline stays on Canvas2D and these targets appear only as cursor hit areas. */
export function RotationHandles({ id, generation, labelFor, poses, onHandlePointerDown, onPointerMove, onPointerUp, onPointerCancel }: { id: string; generation: number; labelFor: (handle: RotationHandleName) => string; poses: readonly RotationHandlePose[]; onHandlePointerDown: (event: PointerEvent<HTMLButtonElement>, handle: RotationHandleName) => void; onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void; onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void; onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void }) {
  return <div className="rotation-handles" data-rotation-handles-for={id} data-hud-generation={generation}>
    {poses.map(pose => <button key={pose.handle} type="button" className="rotation-handle" data-rotation-handle={pose.handle} aria-label={labelFor(pose.handle)} tabIndex={-1} style={{ left: pose.center.x, top: pose.center.y }} onPointerDown={event => onHandlePointerDown(event, pose.handle)} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} />)}
  </div>
}

/** Brilliant-style radius dots. The button is the generous screen-space hit target; its pseudo-element is the small visible marker. */
export function CornerRadiusHandles({ id, generation, labelFor, poses, onHandlePointerDown, onPointerMove, onPointerUp, onPointerCancel }: { id: string; generation: number; labelFor: (corner: CornerRadiusKey) => string; poses: readonly CornerRadiusHandlePose[]; onHandlePointerDown: (event: PointerEvent<HTMLButtonElement>, corner: CornerRadiusKey) => void; onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void; onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void; onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void }) {
  return <div className="corner-radius-handles" data-radius-handles-for={id} data-hud-generation={generation}>
    {poses.map(pose => <button key={pose.corner} type="button" className="corner-radius-handle" data-radius-handle={pose.corner} data-active={pose.active || undefined} aria-label={labelFor(pose.corner)} tabIndex={-1} style={{ left: pose.center.x, top: pose.center.y, transform: `translate(-50%, -50%) rotate(${pose.angle}rad)` }} onPointerDown={event => onHandlePointerDown(event, pose.corner)} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} />)}
  </div>
}

export function NodeLabel({ id, pose, name, selected, locked, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onDoubleClick }: PointerHandlers<HTMLButtonElement> & { id: string; pose: { x: number; y: number; width: number; angle: number }; name: string; selected: boolean; locked: boolean; onDoubleClick: () => void }) {
  return <button type="button" className="node-label node-label-hit" data-node-label={id} data-selected={selected || undefined} data-locked={locked || undefined} disabled={locked} tabIndex={-1} title={name} style={{ left: pose.x, top: pose.y, width: pose.width, transformOrigin: '0 100%', transform: `rotate(${pose.angle}rad) translateY(-100%)` }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onDoubleClick={onDoubleClick}>{name}</button>
}

export function createTextEditorFinisher() {
  let finished = false
  return (action: () => void) => {
    if (finished) return false
    finished = true
    action()
    return true
  }
}

export function NodeNameEditor({ id, pose, value, label, onCommit, onCancel }: { id: string; pose: { x: number; y: number; width: number; angle: number }; value: string; label: string; onCommit: (value: string) => void; onCancel: () => void }) {
  const [finish] = useState(createTextEditorFinisher)
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation()
    if (event.key === 'Enter') { event.preventDefault(); finish(() => onCommit(event.currentTarget.value)) }
    if (event.key === 'Escape') { event.preventDefault(); finish(onCancel) }
  }
  return <input className="node-label-editor" aria-label={label} data-editing={id} defaultValue={value} autoFocus maxLength={128} type="text" style={{ left: pose.x, top: pose.y, width: Math.max(80, pose.width), transformOrigin: '0 100%', transform: `rotate(${pose.angle}rad) translateY(-100%)` }} onKeyDown={onKeyDown} onBlur={event => finish(() => onCommit(event.currentTarget.value))} onFocus={event => event.currentTarget.select()} />
}

export type CanvasTextKeyAction = 'continue' | 'newline' | 'commit' | 'cancel' | 'next' | 'previous'
export function canvasTextKeyAction(event: Pick<KeyboardEvent<HTMLElement>, 'key' | 'ctrlKey' | 'metaKey'> & Partial<Pick<KeyboardEvent<HTMLElement>, 'shiftKey'> & { isComposing: boolean }>): CanvasTextKeyAction {
  if (event.isComposing) return 'continue'
  if (event.key === 'Escape') return 'cancel'
  if (event.key === 'Tab') return event.shiftKey ? 'previous' : 'next'
  if (event.key === 'Enter') return event.ctrlKey || event.metaKey ? 'commit' : 'newline'
  return 'continue'
}

function selectEditableText(element: HTMLElement) {
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.selectNodeContents(element)
  selection.removeAllRanges()
  selection.addRange(range)
}

function placeEditableCaretAtEnd(element: HTMLElement) {
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.selectNodeContents(element)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}

/** Chromium keeps one terminal LF as the caret sentinel after Enter. Paste has no sentinel and must stay byte-for-byte. */
export function normalizeEditablePlainText(value: string, inputType: string): string {
  const normalized = value.replace(/\r\n?/g, '\n')
  return (inputType === 'insertParagraph' || inputType === 'insertLineBreak') && normalized.endsWith('\n\n') ? normalized.slice(0, -1) : normalized
}

const editablePlainText = (element: HTMLElement, inputType: string) => normalizeEditablePlainText(element.innerText, inputType)

/** Paper-style text editing: native caret and selection over one transparent DOM text layer; the preview remains the visible paint. */
export function CanvasTextEditor({ id, value, label, style, onUpdate, onCommit, onCancel, onTraverse }: { id: string; value: string; label: string; style: CSSProperties; onUpdate: (value: string) => boolean; onCommit: () => void; onCancel: () => void; onTraverse: (direction: 'next' | 'previous') => void }) {
  const initialized = useRef(false)
  const acceptedValue = useRef(value)
  const [finish] = useState(createTextEditorFinisher)
  const attach = (element: HTMLDivElement | null) => {
    if (!element || initialized.current) return
    initialized.current = true
    element.textContent = value
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation()
    const action = canvasTextKeyAction({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
    })
    if (action === 'continue' || action === 'newline') return
    event.preventDefault()
    if (action === 'cancel') finish(onCancel)
    else if (action === 'commit') finish(onCommit)
    else finish(() => onTraverse(action))
  }
  const update = (element: HTMLDivElement, inputType: string) => {
    const next = editablePlainText(element, inputType)
    if (onUpdate(next)) { acceptedValue.current = next; return }
    if (next === acceptedValue.current) return
    element.textContent = acceptedValue.current
    placeEditableCaretAtEnd(element)
  }
  return <div ref={attach} className="canvas-text-editor" role="textbox" aria-label={label} aria-multiline="true" data-editing={id} contentEditable="plaintext-only" suppressContentEditableWarning autoFocus style={style} onFocus={event => selectEditableText(event.currentTarget)} onInput={event => update(event.currentTarget, (event.nativeEvent as InputEvent).inputType)} onKeyDown={onKeyDown} onBlur={() => finish(onCommit)} />
}

export function DimensionBadge({ rect, children }: { rect: ScreenRect; children: ReactNode }) {
  return <span className="dimension-badge" style={{ left: rect.x + rect.width / 2, top: rect.y + rect.height }}>{children}</span>
}


export function DocumentTree({ children, label, indicator, copying = false, attach, onPointerMove, onPointerUp, onPointerCancel, onKeyDown }: { children: ReactNode; label: string; indicator?: { top: number; left: number } | null; copying?: boolean; attach?: (element: HTMLDivElement | null) => void; onPointerMove?: (event: PointerEvent<HTMLDivElement>) => void; onPointerUp?: (event: PointerEvent<HTMLDivElement>) => void; onPointerCancel?: (event: PointerEvent<HTMLDivElement>) => void; onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void }) {
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented) return
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'))
    const current = items.indexOf(event.target as HTMLElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
    event.preventDefault()
    items[next]?.focus()
  }
  return <div ref={attach} role="tree" tabIndex={-1} aria-label={label} aria-multiselectable="true" className="document-tree" data-copying={copying || undefined} onKeyDown={navigate} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}>{children}{indicator && <span className="document-layer-drop-indicator" aria-hidden="true" style={{ top: indicator.top, left: indicator.left }} />}</div>
}

export function DocumentLayerItem({ name, toggleLabel, id, depth, selected, childrenCount, expanded, visible, locked, directlyLocked, showLabel, hideLabel, lockLabel, lockDisabled = false, visibilityDisabled = false, renaming = false, renameLabel, icon = 'component', dragging = false, dropTarget = false, onSelect, onToggle, onVisibilityChange, onLockChange, onPointerDown, onIconDoubleClick, onRename, onRenameCommit, onRenameCancel, onRenameTraverse, onContextMenu }: { name: string; toggleLabel: string; id: string; depth: number; selected: boolean; childrenCount: number; expanded: boolean; visible: boolean; locked: boolean; directlyLocked: boolean; showLabel: string; hideLabel: string; lockLabel: string; lockDisabled?: boolean; visibilityDisabled?: boolean; renaming?: boolean; renameLabel?: string; icon?: IconName; dragging?: boolean; dropTarget?: boolean; onSelect: (modifiers: { additive: boolean; range: boolean }) => void; onToggle: (recursive: boolean) => void; onVisibilityChange: (visible: boolean) => void; onLockChange: (locked: boolean) => void; onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void; onIconDoubleClick?: () => void; onRename?: () => void; onRenameCommit?: (name: string) => void; onRenameCancel?: () => void; onRenameTraverse?: (direction: 'next' | 'previous', value: string) => void; onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void }) {
  const cancelled = useRef(false)
  return <div className="document-layer-item" role="treeitem" tabIndex={renaming ? -1 : 0} aria-label={name} aria-level={depth + 1} aria-selected={selected} aria-expanded={childrenCount ? expanded : undefined} data-selected={selected || undefined} data-active={selected ? 'true' : undefined} data-hidden={!visible || undefined} data-locked={locked || undefined} data-dragging={dragging || undefined} data-drop-target={dropTarget || undefined} data-instance-id={id} data-layer-node-id={id} data-layer-row-id={id} style={{ '--layer-depth': depth } as CSSProperties} onPointerDown={onPointerDown} onClick={event => { if (!event.defaultPrevented) onSelect({ additive: event.ctrlKey || event.metaKey, range: event.shiftKey }) }} onContextMenu={onContextMenu} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect({ additive: event.ctrlKey || event.metaKey, range: event.shiftKey }) } if (event.key === 'F2' && onRename) { event.preventDefault(); onRename() } if (childrenCount && (event.key === 'ArrowRight' && !expanded || event.key === 'ArrowLeft' && expanded)) { event.preventDefault(); onToggle(false) } }}>
      {childrenCount ? <button type="button" className="layer-toggle" data-expanded={expanded || undefined} aria-label={toggleLabel} tabIndex={-1} onPointerDownCapture={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onToggle(event.altKey) }}><Icon name="chevron" /></button> : <span className="layer-toggle" aria-hidden="true" />}
      <span className="document-layer-icon" aria-hidden="true" onDoubleClick={event => { event.stopPropagation(); onIconDoubleClick?.() }}><Icon name={icon} /></span>
      {renaming ? <input className="sidebar-inline-name" aria-label={renameLabel} defaultValue={name} autoFocus maxLength={200} onFocus={event => { event.currentTarget.select(); event.currentTarget.scrollIntoView({ block: 'nearest' }) }} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); onRenameCommit?.(event.currentTarget.value) } if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; onRenameCancel?.() } if (event.key === 'Tab') { event.preventDefault(); cancelled.current = true; onRenameTraverse?.(event.shiftKey ? 'previous' : 'next', event.currentTarget.value) } }} onBlur={event => { if (cancelled.current) { cancelled.current = false; return }; onRenameCommit?.(event.currentTarget.value) }} /> : <span className="document-layer-name" onDoubleClick={event => { event.stopPropagation(); onRename?.() }}>{name}</span>}
      <span className="document-layer-actions" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
        <button type="button" className="document-layer-lock" data-locked={locked || undefined} aria-label={lockLabel} title={lockLabel} aria-pressed={directlyLocked} disabled={lockDisabled} onClick={() => onLockChange(!directlyLocked)}><Icon name="lock" /></button>
        <span className="document-layer-visibility"><AppearanceVisibilityButton visible={visible} showLabel={showLabel} hideLabel={hideLabel} disabled={visibilityDisabled} onChange={onVisibilityChange} /></span>
      </span>
  </div>
}

export function DocumentSlotTarget({ rowId, label, depth, dropTarget = false }: { rowId: string; label: string; depth: number; dropTarget?: boolean }) {
  return <div className="document-slot" role="group" aria-label={label} data-layer-row-id={rowId} data-drop-target={dropTarget || undefined} style={{ '--layer-depth': depth } as CSSProperties}><span className="document-slot-label">{label}</span></div>
}

export function CanvasChoice({ label, value, options, onChange, disabled }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean }) {
  return <span className="canvas-choice-control"><select className="input canvas-choice" aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><Icon name="chevron" /></span>
}
