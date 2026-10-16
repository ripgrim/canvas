export type FileOpenProgressSnapshot = Readonly<{
  attempt: number
  fileId: string | null
  status: 'idle' | 'opening' | 'slow'
}>

const idle = (attempt: number): FileOpenProgressSnapshot => Object.freeze({ attempt, fileId: null, status: 'idle' })

export class FileOpenProgressService {
  #snapshot = idle(0)
  #listeners = new Set<() => void>()
  #timer: ReturnType<typeof setTimeout> | null = null
  #controller: AbortController | null = null

  getSnapshot = (): FileOpenProgressSnapshot => this.#snapshot
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }

  begin(fileId: string, slowAfterMs: number): Readonly<{ attempt: number; signal: AbortSignal }> {
    this.cancel()
    const attempt = this.#snapshot.attempt + 1
    const controller = new AbortController()
    this.#controller = controller
    this.#publish(Object.freeze({ attempt, fileId, status: 'opening' }))
    this.#timer = setTimeout(() => {
      this.#timer = null
      if (this.#snapshot.attempt === attempt && this.#snapshot.status === 'opening') this.#publish(Object.freeze({ attempt, fileId, status: 'slow' }))
    }, slowAfterMs)
    return Object.freeze({ attempt, signal: controller.signal })
  }

  finish(attempt: number): void {
    if (this.#snapshot.attempt !== attempt) return
    this.#clearTimer()
    this.#controller = null
    this.#publish(idle(attempt))
  }

  cancel(): void {
    const attempt = this.#snapshot.attempt
    this.#clearTimer()
    this.#controller?.abort(Object.assign(new Error('This file open was cancelled.'), { code: 'file_open_cancelled' }))
    this.#controller = null
    if (this.#snapshot.status !== 'idle') this.#publish(idle(attempt))
  }

  #clearTimer(): void {
    if (this.#timer === null) return
    clearTimeout(this.#timer)
    this.#timer = null
  }

  #publish(snapshot: FileOpenProgressSnapshot): void {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }
}

export const fileOpenProgressService = new FileOpenProgressService()
