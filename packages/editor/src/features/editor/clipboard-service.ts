import type { Atom } from './types'
import { clipboardTargetIsEditable, prepareClipboardCandidate, resolveClipboardCandidate } from './clipboard-codec'
import type { ClipboardCandidate, ClipboardDataSource, ResolvedClipboardCandidate } from './clipboard-codec'

export type CanvasClipboardServiceTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>
export type CanvasClipboardWrite = Readonly<{ html: string; text: string; afterWrite?: () => void }>

export function createCanvasClipboardService<Authority = undefined>(
  target: CanvasClipboardServiceTarget,
  receive: (candidate: ClipboardCandidate, authority: Authority) => void,
  atoms: () => readonly Atom[] = () => [],
  prepare: (candidate: ResolvedClipboardCandidate) => Promise<ClipboardCandidate> = prepareClipboardCandidate,
  claim: (candidate: ResolvedClipboardCandidate) => boolean = candidate => candidate.kind !== 'unsupported',
  write: (kind: 'copy' | 'cut') => CanvasClipboardWrite | null = () => null,
  afterWrite: (kind: 'copy' | 'cut') => void = () => undefined,
  capture: (event?: ClipboardEvent | DragEvent) => Authority = (() => undefined as Authority),
  dropTarget: (event: DragEvent) => boolean = () => false,
) {
  let started = false
  let generation = 0
  const receiveData = (event: ClipboardEvent | DragEvent, data: DataTransfer) => {
    if (clipboardTargetIsEditable(event.target)) return
    const authority = capture(event)
    const candidate = resolveClipboardCandidate(data as unknown as ClipboardDataSource, atoms())
    if (candidate.kind === 'unsupported') { receive(candidate, authority); return }
    if (!claim(candidate)) return
    event.preventDefault()
    const current = generation
    void prepare(candidate).then(prepared => { if (started && generation === current) receive(prepared, authority) }, () => {
      if (started && generation === current) receive(Object.freeze({ kind: 'unsupported', diagnostic: 'Clipboard data could not be prepared' }), authority)
    })
  }
  const paste = (event: ClipboardEvent) => { if (event.clipboardData) receiveData(event, event.clipboardData) }
  const dragover = (event: DragEvent) => {
    if (!dropTarget(event) || clipboardTargetIsEditable(event.target) || !event.dataTransfer) return
    const candidate = resolveClipboardCandidate(event.dataTransfer as unknown as ClipboardDataSource, atoms())
    if (candidate.kind !== 'unsupported' && claim(candidate)) event.preventDefault()
  }
  const drop = (event: DragEvent) => { if (dropTarget(event) && event.dataTransfer) receiveData(event, event.dataTransfer) }
  const writeClipboard = (kind: 'copy' | 'cut') => (event: ClipboardEvent) => {
    if (clipboardTargetIsEditable(event.target) || !event.clipboardData) return
    const value = write(kind)
    if (!value) return
    event.clipboardData.setData('text/html', value.html)
    event.clipboardData.setData('text/plain', value.text)
    event.preventDefault()
    value.afterWrite?.()
    afterWrite(kind)
  }
  const copy = writeClipboard('copy')
  const cut = writeClipboard('cut')
  return Object.freeze({
    start() {
      if (started) return
      started = true
      generation += 1
      target.addEventListener('paste', paste as EventListener)
      target.addEventListener('copy', copy as EventListener)
      target.addEventListener('cut', cut as EventListener)
      target.addEventListener('dragover', dragover as EventListener)
      target.addEventListener('drop', drop as EventListener)
    },
    stop() {
      if (!started) return
      started = false
      generation += 1
      target.removeEventListener('paste', paste as EventListener)
      target.removeEventListener('copy', copy as EventListener)
      target.removeEventListener('cut', cut as EventListener)
      target.removeEventListener('dragover', dragover as EventListener)
      target.removeEventListener('drop', drop as EventListener)
    },
  })
}
