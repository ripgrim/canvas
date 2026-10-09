import type { RefObject } from 'react'
import './code-tools.css'

export function CodeInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="code-input"><span>{label}</span><textarea aria-label={label} spellCheck={false} value={value} onChange={event => onChange(event.currentTarget.value)} /></label>
}
export function CodeOutput({ label, value, fieldRef }: { label: string; value: string; fieldRef: RefObject<HTMLTextAreaElement | null> }) {
  return <label className="code-input"><span>{label}</span><textarea ref={fieldRef} aria-label={label} spellCheck={false} value={value} readOnly /></label>
}