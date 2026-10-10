import { useRef } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { DragSession } from './appearance-atoms'
import './radius.css'

type Corner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight'

const cornerPaths: Record<Corner, string> = {
  topLeft: 'M13 4H8a4 4 0 0 0-4 4v5',
  topRight: 'M3 4h5a4 4 0 0 1 4 4v5',
  bottomLeft: 'M13 12H8a4 4 0 0 1-4-4V3',
  bottomRight: 'M3 12h5a4 4 0 0 0 4-4V3',
}

export function RadiusCornerGlyph({ corner }: { corner: Corner }) {
  return <svg className="radius-corner-glyph" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"><path d={cornerPaths[corner]} /></svg>
}

export function RadiusModeButton({ individual, label, disabled = false, onChange }: { individual: boolean; label: string; disabled?: boolean; onChange: (individual: boolean) => void }) {
  return <button type="button" className="radius-mode-button" aria-label={label} title={label} aria-pressed={individual} disabled={disabled} onClick={() => onChange(!individual)}>
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"><path d="M6 3H4a1 1 0 0 0-1 1v2M10 3h2a1 1 0 0 1 1 1v2M6 13H4a1 1 0 0 1-1-1v-2M10 13h2a1 1 0 0 0 1-1v-2" /></svg>
  </button>
}

export function RadiusUnifiedRow({ slider, field }: { slider: ReactNode; field: ReactNode }) {
  return <div className="radius-unified-row">{slider}<span className="radius-value-slot">{field}</span></div>
}

export function RadiusCornerGrid({ children }: { children: ReactNode }) {
  return <div className="radius-corner-grid">{children}</div>
}

/** Native range semantics with a pointer-owned preview session. Escape and pointer cancellation restore the base. */
export function RadiusSlider({ label, mixedText, value, max, disabled = false, onCommit, onScrubStart }: { label: string; mixedText: string; value: number | null; max: number; disabled?: boolean; onCommit: (value: number) => void; onScrubStart: () => DragSession<number> | null }) {
  const session = useRef<DragSession<number> | null>(null)
  const shown = Math.min(max, Math.max(0, value ?? 0))
  const finish = (cancel: boolean) => {
    const current = session.current
    session.current = null
    if (!current) return
    if (cancel) current.cancel(); else current.end()
  }
  const pointerDown = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (disabled || event.button !== 0) return
    session.current = onScrubStart()
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const changed = (raw: string) => {
    const next = Number(raw)
    if (!Number.isFinite(next)) return
    if (session.current) session.current.move(next); else onCommit(next)
  }
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape' || !session.current) return
    event.preventDefault()
    event.stopPropagation()
    finish(true)
  }
  const style = { '--radius-slider-value': `${max > 0 ? shown / max * 100 : 0}%` } as CSSProperties
  return <input className="radius-slider" type="range" min={0} max={max} step={1} value={shown} aria-label={label} aria-valuetext={value === null ? mixedText : `${value} px`} disabled={disabled} data-mixed={value === null || undefined} style={style} onPointerDown={pointerDown} onPointerUp={() => finish(false)} onPointerCancel={() => finish(true)} onKeyDown={keyDown} onChange={event => changed(event.currentTarget.value)} />
}
