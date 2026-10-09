import { useId, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { Popover } from '@base-ui/react/popover'
import { colorCopy as copy } from '../features/editor/color-copy'
import { formatHex, formatHsl, formatRgb, hsvToRgb, parseColor, rgbToHsv } from '../features/editor/color'
import type { Color, Hsv } from '../features/editor/color'
import './color-picker.css'

type Format = 'HEX' | 'RGB' | 'HSL'
export type ColorPickerProps = {
  label: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  mode?: 'light' | 'dark'
  allowAlpha?: boolean
  /** `swatch` renders only a compact swatch trigger for use inside a color field. */
  variant?: 'field' | 'swatch'
  /** Controlled popup state, for opening the picker from another gesture such as a double-click. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

const display = (color: Color, format: Format, allowAlpha: boolean) => format === 'RGB' ? formatRgb(color) : format === 'HSL' ? formatHsl(color) : formatHex(color, allowAlpha && color.a < 1)
const adjustmentKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])

function ColorSlider({ label, value, max, onChange, onCommit, onCancel, background, disabled }: { label: string; value: number; max: number; onChange: (value: number) => void; onCommit: () => void; onCancel: () => void; background: string; disabled: boolean }) {
  const cancelled = useRef(false)
  const style = { background } as CSSProperties
  const commit = () => { if (!cancelled.current) onCommit() }
  return <label className="color-picker-slider"><span>{label}</span><input type="range" min={0} max={max} step={1} value={Math.round(value)} disabled={disabled} aria-label={label} style={style}
    onChange={event => { if (!cancelled.current) onChange(Number(event.currentTarget.value)) }}
    onPointerDown={() => { cancelled.current = false }}
    onPointerUp={commit}
    onPointerCancel={() => { cancelled.current = true; onCancel() }}
    onBlur={commit}
    onKeyDown={event => {
      if (adjustmentKeys.has(event.key)) cancelled.current = false
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelled.current = true; onCancel() }
    }}
    onKeyUp={event => { if (adjustmentKeys.has(event.key)) commit() }}
  /><output>{Math.round(value)}{max === 100 ? '%' : max === 360 ? '\u00b0' : ''}</output></label>
}

type Draft = { base: string; color: Color | null; hsv: Hsv | null; text: string; textDirty: boolean; error: string | null }
const makeDraft = (value: string, format: Format, allowAlpha: boolean): Draft => {
  const color = parseColor(value)
  return { base: value, color, hsv: color ? rgbToHsv(color) : null, text: color ? display(color, format, allowAlpha) : value, textDirty: false, error: null }
}

function ColorDraft({ label, value, onChange, format, onFormatChange, allowAlpha }: { label: string; value: string; onChange: (value: string) => void; format: Format; onFormatChange: (format: Format) => void; allowAlpha: boolean }) {
  const inputId = useId()
  const errorId = useId()
  const [storedDraft, setDraft] = useState(() => makeDraft(value, format, allowAlpha))
  const externalDraft = makeDraft(value, format, allowAlpha)
  const followsValue = storedDraft.base === value
  const draft = followsValue ? storedDraft : storedDraft.textDirty ? { ...externalDraft, text: storedDraft.text, textDirty: true, error: storedDraft.error } : externalDraft
  const pending = useRef<Color | null>(null)
  const emitted = useRef<{ base: string; value: string } | null>(null)
  const { color, hsv: current, text, error } = draft
  const commit = (candidate: Color | null, nextDraft: Draft) => {
    if (!candidate) { setDraft({ ...nextDraft, error: copy.invalid }); return }
    if (!allowAlpha && candidate.a !== 1) { setDraft({ ...nextDraft, error: copy.alphaUnsupported }); return }
    const next = formatHex(candidate, allowAlpha && candidate.a < 1)
    const actual = parseColor(value)
    const normalized = actual ? formatHex(actual, allowAlpha && actual.a < 1) : value
    const previous = emitted.current
    const last = previous && (previous.base === value || previous.value === value) ? previous.value : normalized
    setDraft({ ...nextDraft, base: next, textDirty: false, error: null })
    if (next !== last) { emitted.current = { base: value, value: next }; onChange(next) }
  }
  const commitText = () => {
    const parsed = parseColor(text)
    commit(parsed, parsed ? { ...draft, color: parsed, hsv: rgbToHsv(parsed) } : draft)
  }
  const cancel = () => { pending.current = null; emitted.current = null; setDraft(makeDraft(value, format, allowAlpha)) }
  const commitSlider = () => {
    const candidate = pending.current
    pending.current = null
    if (candidate) commit(candidate, draft)
  }
  const setHsv = (part: keyof Hsv, next: number) => {
    if (!current) return
    const changed = { ...current, [part]: part === 'a' ? next / 100 : next }
    const nextColor = hsvToRgb(changed)
    emitted.current = null
    pending.current = nextColor
    setDraft({ base: value, color: nextColor, hsv: changed, text: display(nextColor, format, allowAlpha), textDirty: false, error: null })
  }
  const onTextKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); commitText() }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() }
  }
  const hue = current?.h ?? 0
  const saturation = current?.s ?? 0
  const bright = current?.v ?? 0
  const opaque = color ? formatRgb({ ...color, a: 1 }) : 'transparent'
  const hueColor = formatRgb(hsvToRgb({ h: hue, s: 100, v: 100, a: 1 }))
  const saturated = formatRgb(hsvToRgb({ h: hue, s: saturation, v: 100, a: 1 }))
  return <div className="color-picker-content">
    <div className="color-picker-current"><span className="color-picker-swatch" aria-hidden="true"><span className="color-picker-swatch-fill" style={{ backgroundColor: color ? formatRgb(color) : 'transparent' }} /></span><span>{color ? formatHex(color, allowAlpha && color.a < 1) : copy.unsupportedValue}</span></div>
    <ColorSlider label={copy.hue} value={hue} max={360} onChange={next => setHsv('h', next)} onCommit={commitSlider} onCancel={cancel} background="linear-gradient(to right, red, yellow, lime, cyan, blue, magenta, red)" disabled={!color} />
    <ColorSlider label={copy.saturation} value={saturation} max={100} onChange={next => setHsv('s', next)} onCommit={commitSlider} onCancel={cancel} background={`linear-gradient(to right, ${formatRgb(hsvToRgb({ h: hue, s: 0, v: bright, a: 1 }))}, ${hueColor})`} disabled={!color} />
    <ColorSlider label={copy.brightness} value={bright} max={100} onChange={next => setHsv('v', next)} onCommit={commitSlider} onCancel={cancel} background={`linear-gradient(to right, black, ${saturated})`} disabled={!color} />
    {allowAlpha && <ColorSlider label={copy.alpha} value={(color?.a ?? 1) * 100} max={100} onChange={next => setHsv('a', next)} onCommit={commitSlider} onCancel={cancel} background={`linear-gradient(to right, transparent, ${opaque})`} disabled={!color} />}
    <div className="color-picker-fields"><label htmlFor={`${inputId}-format`}>{copy.format}<select id={`${inputId}-format`} value={format} onChange={event => {
      const next = event.currentTarget.value as Format
      onFormatChange(next)
      if (!draft.textDirty && color) setDraft({ ...draft, text: display(color, next, allowAlpha) })
    }}><option value="HEX">HEX</option><option value="RGB">RGB</option><option value="HSL">HSL</option></select></label><label htmlFor={inputId}>{copy.value}<input id={inputId} value={text} spellCheck={false} aria-label={`${label} ${copy.value}`} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} onChange={event => { pending.current = null; emitted.current = null; setDraft({ ...draft, text: event.currentTarget.value, textDirty: true, error: null }) }} onBlur={commitText} onKeyDown={onTextKeyDown} /></label></div>
    {error && <p id={errorId} className="color-picker-error" role="alert">{error}</p>}
  </div>
}

export function ColorPicker({ label, value, onChange, disabled = false, mode = 'light', allowAlpha = true, variant = 'field', open: controlledOpen, onOpenChange }: ColorPickerProps) {
  const [ownOpen, setOwnOpen] = useState(false)
  const open = controlledOpen ?? ownOpen
  const setOpen = (next: boolean) => { setOwnOpen(next); onOpenChange?.(next) }
  const [format, setFormat] = useState<Format>('HEX')
  const color = parseColor(value)
  return <Popover.Root open={open} onOpenChange={setOpen}><Popover.Trigger className={variant === 'swatch' ? 'color-picker-trigger color-picker-trigger-swatch' : 'color-picker-trigger'} disabled={disabled} aria-label={copy.open(label)} title={variant === 'swatch' ? copy.open(label) : undefined}><span className="color-picker-swatch" aria-hidden="true"><span className="color-picker-swatch-fill" style={{ backgroundColor: color ? formatRgb(color) : 'transparent' }} /></span>{variant === 'field' && <span>{value}</span>}</Popover.Trigger><Popover.Portal className={`theme-${mode}`}><Popover.Positioner side="left" align="start" className="color-picker-positioner"><Popover.Popup className="color-picker-popup"><Popover.Title className="color-picker-title">{label}</Popover.Title><ColorDraft label={label} value={value} onChange={onChange} format={format} onFormatChange={setFormat} allowAlpha={allowAlpha} /><Popover.Close className="color-picker-close">{copy.close}</Popover.Close></Popover.Popup></Popover.Positioner></Popover.Portal></Popover.Root>
}
