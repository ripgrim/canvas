import { useId, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { Popover } from '@base-ui/react/popover'
import { colorCopy as copy } from '../features/editor/color-copy'
import { formatHex, formatRgb, hslToRgb, hsvToRgb, lchToRgb, parseColor, rgbToHsl, rgbToHsv, rgbToLch } from '../features/editor/color'
import type { Color, Hsv } from '../features/editor/color'
import './color-picker.css'

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

type Fields = {
  l: string
  c: string
  lh: string
  hh: string
  s: string
  light: string
  r: string
  g: string
  b: string
  hex: string
  alpha: string
}

type Draft = { base: string; color: Color | null; hsv: Hsv | null; fields: Fields; error: string | null }
type Emission = { base: string; value: string }
type EyeDropperConstructor = new () => { open: () => Promise<{ sRGBHex: string }> }

const fixed = (value: number, precision = 1) => Number(value.toFixed(precision)).toString()
const fieldsFromColor = (color: Color): Fields => {
  const lch = rgbToLch(color)
  const hsl = rgbToHsl(color)
  return {
    l: fixed(lch.l), c: fixed(lch.c), lh: fixed(lch.h),
    hh: fixed(hsl.h), s: fixed(hsl.s), light: fixed(hsl.l),
    r: String(Math.round(color.r)), g: String(Math.round(color.g)), b: String(Math.round(color.b)),
    hex: formatHex(color, false), alpha: fixed(color.a * 100),
  }
}
const emptyFields: Fields = { l: '', c: '', lh: '', hh: '', s: '', light: '', r: '', g: '', b: '', hex: '', alpha: '' }
const makeDraft = (value: string): Draft => {
  const color = parseColor(value)
  return { base: value, color, hsv: color ? rgbToHsv(color) : null, fields: color ? fieldsFromColor(color) : emptyFields, error: null }
}
const inRange = (value: number, maximum: number) => Number.isFinite(value) && value >= 0 && value <= maximum

function Icon({ name }: { name: 'copy' | 'eyedropper' | 'close' }) {
  if (name === 'copy') return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1" /><path d="M3 10V3h7" /></svg>
  if (name === 'eyedropper') return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m10.5 2.5 3 3-7.75 7.75H2.5v-3.2L10.5 2.5Z" /><path d="m8.75 4.25 3 3M2.5 13.25h4" /></svg>
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg>
}

function CopyButton({ label, value, onCopied }: { label: string; value: string; onCopied: () => void }) {
  const copyValue = () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return
    void navigator.clipboard.writeText(value).then(onCopied)
  }
  return <button type="button" className="color-picker-icon-button" aria-label={copy.copyValue(label)} title={copy.copyValue(label)} onClick={copyValue}><Icon name="copy" /></button>
}

type RailProps = {
  label: string
  value: number
  maximum: number
  background: string
  disabled: boolean
  onPreview: (value: number) => void
  onCommit: () => void
  onCancel: () => void
}

function ColorRail({ label, value, maximum, background, disabled, onPreview, onCommit, onCancel }: RailProps) {
  const cancelled = useRef(false)
  const commit = () => { if (!cancelled.current) onCommit() }
  return <input
    className="color-picker-rail"
    type="range"
    min={0}
    max={maximum}
    step={1}
    value={Math.round(value)}
    disabled={disabled}
    aria-label={label}
    style={{ background }}
    onChange={event => { if (!cancelled.current) onPreview(Number(event.currentTarget.value)) }}
    onPointerDown={() => { cancelled.current = false }}
    onPointerUp={commit}
    onPointerCancel={() => { cancelled.current = true; onCancel() }}
    onKeyDown={event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        cancelled.current = true
        onCancel()
      }
    }}
    onKeyUp={event => { if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End' || event.key.startsWith('Page')) commit() }}
  />
}

function ColorDraft({ label, value, onChange, allowAlpha }: { label: string; value: string; onChange: (value: string) => void; allowAlpha: boolean }) {
  const errorId = useId()
  const [stored, setStored] = useState(() => makeDraft(value))
  const [copied, setCopied] = useState<string | null>(null)
  const emitted = useRef<Emission | null>(null)
  const pending = useRef<Color | null>(null)
  const pointerCancelled = useRef(false)
  const expectedEmission = emitted.current
  const followsValue = stored.base === value || Boolean(expectedEmission && expectedEmission.base === value && expectedEmission.value === stored.base)
  const draft = followsValue ? stored : makeDraft(value)
  const { color, hsv, fields, error } = draft

  const preview = (candidate: Color) => {
    const next = { ...candidate, a: allowAlpha ? candidate.a : 1 }
    pending.current = next
    setStored({ base: value, color: next, hsv: rgbToHsv(next), fields: fieldsFromColor(next), error: null })
  }
  const cancel = () => {
    pending.current = null
    emitted.current = null
    setStored(makeDraft(value))
  }
  const commit = (candidate: Color | null) => {
    pending.current = null
    if (!candidate) {
      setStored({ ...draft, error: copy.invalid })
      return
    }
    if (!allowAlpha && candidate.a !== 1) {
      setStored({ ...draft, error: copy.alphaUnsupported })
      return
    }
    const next = formatHex(candidate, allowAlpha && candidate.a < 1)
    const actual = parseColor(value)
    const normalized = actual ? formatHex(actual, allowAlpha && actual.a < 1) : value
    const previous = emitted.current
    const last = previous && (previous.base === value || previous.value === value) ? previous.value : normalized
    emitted.current = { base: value, value: next }
    setStored({ base: next, color: candidate, hsv: rgbToHsv(candidate), fields: fieldsFromColor(candidate), error: null })
    if (next !== last) onChange(next)
  }
  const commitPending = () => { if (pending.current) commit(pending.current) }
  const updateHsv = (part: keyof Hsv, next: number) => {
    if (!hsv) return
    preview(hsvToRgb({ ...hsv, [part]: part === 'a' ? next / 100 : next }))
  }
  const updatePlane = (event: PointerEvent<HTMLDivElement>) => {
    if (!hsv) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const saturation = Math.max(0, Math.min(100, (event.clientX - bounds.left) / bounds.width * 100))
    const brightness = Math.max(0, Math.min(100, 100 - (event.clientY - bounds.top) / bounds.height * 100))
    preview(hsvToRgb({ ...hsv, s: saturation, v: brightness }))
  }
  const onPlaneKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!hsv) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); return }
    const changes: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }
    const change = changes[event.key]
    if (!change) return
    event.preventDefault()
    const candidate = hsvToRgb({ ...hsv, s: Math.max(0, Math.min(100, hsv.s + change[0])), v: Math.max(0, Math.min(100, hsv.v + change[1])) })
    preview(candidate)
    commit(candidate)
  }
  const updateField = (key: keyof Fields, next: string) => setStored({ ...draft, base: value, fields: { ...fields, [key]: next }, error: null })
  const alphaValue = () => {
    if (!fields.alpha.trim()) return allowAlpha ? null : 1
    const next = Number(fields.alpha)
    return allowAlpha && inRange(next, 100) ? next / 100 : allowAlpha ? null : 1
  }
  const commitFields = (group: 'lch' | 'hsl' | 'rgb' | 'hex') => {
    const alpha = alphaValue()
    if (alpha === null) { commit(null); return }
    if (group === 'hex') {
      const parsed = parseColor(fields.hex.startsWith('#') ? fields.hex : `#${fields.hex}`)
      commit(parsed ? { ...parsed, a: parsed.a < 1 ? parsed.a : alpha } : null)
      return
    }
    const fieldValues = group === 'lch' ? [fields.l, fields.c, fields.lh] : group === 'hsl' ? [fields.hh, fields.s, fields.light] : [fields.r, fields.g, fields.b]
    if (fieldValues.some(part => !part.trim())) { commit(null); return }
    const numbers = fieldValues.map(Number)
    if (numbers.some(part => !Number.isFinite(part))) { commit(null); return }
    if (group === 'lch') commit(inRange(numbers[0]!, 100) && inRange(numbers[1]!, 150) && inRange(numbers[2]!, 360) ? lchToRgb({ l: numbers[0]!, c: numbers[1]!, h: numbers[2]!, a: alpha }) : null)
    if (group === 'hsl') commit(inRange(numbers[0]!, 360) && inRange(numbers[1]!, 100) && inRange(numbers[2]!, 100) ? hslToRgb({ h: numbers[0]!, s: numbers[1]!, l: numbers[2]!, a: alpha }) : null)
    if (group === 'rgb') commit(numbers.every(part => inRange(part, 255)) ? { r: numbers[0]!, g: numbers[1]!, b: numbers[2]!, a: alpha } : null)
  }
  const keyCommit = (group: 'lch' | 'hsl' | 'rgb' | 'hex') => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); commitFields(group) }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() }
  }
  const openEyeDropper = () => {
    const Constructor = typeof window === 'undefined' ? undefined : (window as Window & { EyeDropper?: EyeDropperConstructor }).EyeDropper
    if (!Constructor) { setStored({ ...draft, error: copy.eyedropperUnavailable }); return }
    void new Constructor().open().then(result => {
      const picked = parseColor(result.sRGBHex)
      if (!picked) { setStored({ ...draft, error: copy.eyedropperFailed }); return }
      const candidate = { ...picked, a: color?.a ?? 1 }
      preview(candidate)
      commit(candidate)
    }).catch(reason => {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      setStored({ ...draft, error: copy.eyedropperFailed })
    })
  }
  const noteCopied = (name: string) => { setCopied(name) }
  const hue = hsv?.h ?? 0
  const alpha = (color?.a ?? 1) * 100
  const opaque = color ? formatRgb({ ...color, a: 1 }) : 'transparent'
  const hueBackground = 'linear-gradient(to bottom, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)'
  const alphaBackground = `linear-gradient(to bottom, ${opaque}, transparent), repeating-conic-gradient(#999 0 25%, #fff 0 50%) 0 0 / 8px 8px`
  const swatch = color ? formatRgb(color) : 'transparent'
  const previous = parseColor(value)
  const eyedropperAvailable = typeof window !== 'undefined' && 'EyeDropper' in window

  const row = (name: 'lch' | 'hsl' | 'rgb', keys: Array<keyof Fields>, labels: string[]) => <div className="color-picker-value-row">
    <div className="color-picker-inputs">{keys.map((key, index) => <label key={key}><input value={fields[key]} inputMode="decimal" aria-label={`${name.toUpperCase()} ${labels[index]}`} onChange={event => updateField(key, event.currentTarget.value)} onBlur={() => commitFields(name)} onKeyDown={keyCommit(name)} /><span>{labels[index]}</span></label>)}</div>
    <CopyButton label={name.toUpperCase()} value={keys.map(key => fields[key]).join(' ')} onCopied={() => noteCopied(name)} />
  </div>

  return <div className="color-picker-content" onKeyDown={event => { if (event.key === 'Escape') cancel() }}>
    <div className="color-picker-workspace">
      <div
        className="color-picker-plane"
        role="slider"
        tabIndex={color ? 0 : -1}
        aria-label={`${label} saturation and brightness`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv?.s ?? 0)}
        aria-valuetext={hsv ? `${fixed(hsv.s)}% saturation, ${fixed(hsv.v)}% brightness` : copy.unsupportedValue}
        style={{ backgroundColor: formatRgb(hsvToRgb({ h: hue, s: 100, v: 100, a: 1 })) }}
        onPointerDown={event => { pointerCancelled.current = false; event.currentTarget.setPointerCapture(event.pointerId); updatePlane(event) }}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updatePlane(event) }}
        onPointerUp={event => { updatePlane(event); event.currentTarget.releasePointerCapture(event.pointerId); if (!pointerCancelled.current) commitPending() }}
        onPointerCancel={() => { pointerCancelled.current = true; cancel() }}
        onKeyDown={onPlaneKeyDown}
      ><span className="color-picker-plane-white" /><span className="color-picker-plane-black" /><span className="color-picker-plane-thumb" style={{ left: `${hsv?.s ?? 0}%`, top: `${100 - (hsv?.v ?? 0)}%` }} /></div>
      <ColorRail label={copy.hue} value={hue} maximum={360} background={hueBackground} disabled={!color} onPreview={next => updateHsv('h', next)} onCommit={commitPending} onCancel={cancel} />
      {allowAlpha && <ColorRail label={copy.alpha} value={alpha} maximum={100} background={alphaBackground} disabled={!color} onPreview={next => updateHsv('a', next)} onCommit={commitPending} onCancel={cancel} />}
    </div>
    <div className="color-picker-details">
      <div className="color-picker-preview" aria-label={`${copy.previous} and ${copy.next} colors`}>
        <span><span>{copy.previous}</span><i style={{ backgroundColor: previous ? formatRgb(previous) : 'transparent' }} /></span>
        <span><span>{copy.next}</span><i style={{ backgroundColor: swatch }} /></span>
      </div>
      {row('lch', ['l', 'c', 'lh'], ['L', 'C', 'H'])}
      {row('hsl', ['hh', 's', 'light'], ['H', 'S', 'L'])}
      {row('rgb', ['r', 'g', 'b'], ['R', 'G', 'B'])}
      <div className="color-picker-value-row color-picker-hex-row">
        <div className="color-picker-inputs"><label><input value={fields.hex} spellCheck={false} aria-label={copy.hex} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} onChange={event => updateField('hex', event.currentTarget.value)} onBlur={() => commitFields('hex')} onKeyDown={keyCommit('hex')} /><span>{copy.hex}</span></label>{allowAlpha && <label className="color-picker-alpha-field"><input value={fields.alpha} inputMode="decimal" aria-label={copy.alpha} onChange={event => updateField('alpha', event.currentTarget.value)} onBlur={() => commitFields('hex')} onKeyDown={keyCommit('hex')} /><span>%</span></label>}</div>
        <CopyButton label={copy.hex} value={`${fields.hex} / ${fields.alpha}%`} onCopied={() => noteCopied('hex')} />
      </div>
      <div className="color-picker-status" aria-live="polite">{error ? <span id={errorId} className="color-picker-error" role="alert">{error}</span> : !color ? copy.unsupportedValue : copied ? `${copy.copied} ${copied.toUpperCase()}` : null}</div>
    </div>
    <button type="button" className="color-picker-eyedropper" aria-label={copy.eyedropper} title={eyedropperAvailable ? copy.eyedropper : copy.eyedropperUnavailable} disabled={!eyedropperAvailable || !color} onClick={openEyeDropper}><Icon name="eyedropper" /></button>
  </div>
}

export function ColorPicker({ label, value, onChange, disabled = false, mode = 'light', allowAlpha = true, variant = 'field', open: controlledOpen, onOpenChange }: ColorPickerProps) {
  const [ownOpen, setOwnOpen] = useState(false)
  const open = controlledOpen ?? ownOpen
  const setOpen = (next: boolean) => { setOwnOpen(next); onOpenChange?.(next) }
  const color = parseColor(value)
  return <Popover.Root open={open} onOpenChange={setOpen}><Popover.Trigger className={variant === 'swatch' ? 'color-picker-trigger color-picker-trigger-swatch' : 'color-picker-trigger'} disabled={disabled} aria-label={copy.open(label)} title={variant === 'swatch' ? copy.open(label) : undefined}><span className="color-picker-swatch" aria-hidden="true"><span className="color-picker-swatch-fill" style={{ backgroundColor: color ? formatRgb(color) : 'transparent' }} /></span>{variant === 'field' && <span>{value}</span>}</Popover.Trigger><Popover.Portal className={`theme-${mode}`}><Popover.Positioner side="left" align="start" sideOffset={8} className="color-picker-positioner"><Popover.Popup className="color-picker-popup"><div className="color-picker-header"><div className="color-picker-space-tabs"><span>{copy.srgb}</span><button type="button" disabled title={copy.displayP3Unavailable}>{copy.displayP3}</button></div><Popover.Close className="color-picker-close" aria-label={copy.close}><Icon name="close" /></Popover.Close></div><Popover.Title className="color-picker-title">{label}</Popover.Title><ColorDraft label={label} value={value} onChange={onChange} allowAlpha={allowAlpha} /></Popover.Popup></Popover.Positioner></Popover.Portal></Popover.Root>
}
