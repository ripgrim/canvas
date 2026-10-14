import type { FontFeatureSnapshot } from './font-feature-types'

const idle: FontFeatureSnapshot = { error: null, features: [], status: 'idle' }

export function createFontFeatureService() {
  const listeners = new Set<() => void>()
  const snapshots = new Map<string, FontFeatureSnapshot>()
  const sources = new Map<string, ArrayBuffer>()
  const pending = new Set<string>()
  let worker: Worker | null = null
  const publish = (key: string, snapshot: FontFeatureSnapshot) => {
    snapshots.set(key, snapshot)
    for (const listener of listeners) listener()
  }
  const ensureWorker = () => {
    if (worker) return worker
    worker = new Worker(new URL('./font-feature-worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<Readonly<{ key: string; features?: FontFeatureSnapshot['features']; error?: string }>>) => {
      pending.delete(event.data.key)
      publish(event.data.key, event.data.error
        ? { error: event.data.error, features: [], status: 'error' }
        : { error: null, features: event.data.features ?? [], status: event.data.features?.length ? 'loaded' : 'unavailable' })
    }
    worker.onerror = () => {
      for (const key of pending) publish(key, { error: 'Font feature parsing failed.', features: [], status: 'error' })
      pending.clear()
      worker?.terminate()
      worker = null
    }
    return worker
  }
  const unavailable = (key: string) => { if (!snapshots.has(key)) publish(key, { error: null, features: [], status: 'unavailable' }) }
  return {
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot(key: string): FontFeatureSnapshot { return snapshots.get(key) ?? idle },
    register(key: string, bytes: ArrayBuffer): void { sources.set(key, bytes) },
    unavailable,
    inspect(key: string): void {
      if (pending.has(key) || snapshots.get(key)?.status === 'loaded' || snapshots.get(key)?.status === 'unavailable') return
      const bytes = sources.get(key)
      if (!bytes) { unavailable(key); return }
      pending.add(key)
      publish(key, { error: null, features: [], status: 'loading' })
      const copy = bytes.slice(0)
      ensureWorker().postMessage({ key, bytes: copy }, [copy])
    },
    dispose(): void {
      worker?.terminate()
      worker = null
      pending.clear()
      sources.clear()
      snapshots.clear()
    },
  }
}

export const fontFeatureService = createFontFeatureService()
export const fontFeatureKey = (family: string, style: string, weight: number): string => `${family.trim().split(',')[0]?.replace(/^['"]|['"]$/g, '')}:${style}:${weight}`
