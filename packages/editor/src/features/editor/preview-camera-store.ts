import type { PreviewCamera } from '@canvas/preview-runtime/protocol'

export type PreviewCameraSnapshot = Readonly<{
  generation: number
  sentSequence: number
  appliedSequence: number
  camera: Readonly<PreviewCamera> | null
  settled: boolean
}> | null

/** The camera the preview runtime has applied. Input continues to use the document store's target camera. */
export function createPreviewCameraStore() {
  let snapshot: PreviewCameraSnapshot = null
  const listeners = new Set<() => void>()
  const expect = (generation: number, sequence: number) => {
    if (!Number.isSafeInteger(generation) || generation < 0 || !Number.isSafeInteger(sequence) || sequence < 0) return false
    if (snapshot && (generation < snapshot.generation || generation === snapshot.generation && sequence <= snapshot.sentSequence)) return false
    const camera = snapshot?.generation === generation ? snapshot.camera : null
    const appliedSequence = snapshot?.generation === generation ? snapshot.appliedSequence : -1
    snapshot = Object.freeze({ generation, sentSequence: sequence, appliedSequence, camera, settled: appliedSequence >= sequence })
    for (const listener of listeners) listener()
    return true
  }
  const publish = (generation: number, sequence: number, camera: PreviewCamera) => {
    if (!Number.isSafeInteger(generation) || generation < 0 || !Number.isSafeInteger(sequence) || sequence < 0) return false
    if (!snapshot || generation !== snapshot.generation || sequence > snapshot.sentSequence || sequence <= snapshot.appliedSequence) return false
    snapshot = Object.freeze({ generation, sentSequence: snapshot.sentSequence, appliedSequence: sequence, camera: Object.freeze({ ...camera }), settled: sequence >= snapshot.sentSequence })
    for (const listener of listeners) listener()
    return true
  }
  const reset = () => {
    if (snapshot === null) return
    snapshot = null
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    expect,
    publish,
    reset,
  }
}

export const previewCameraStore = createPreviewCameraStore()
