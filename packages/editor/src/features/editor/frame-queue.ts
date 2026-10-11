export type FrameScheduler = (callback: () => void) => number
export type FrameCanceller = (frame: number) => void

/** Coalesces any number of requests into one read of the latest state on the next paint frame. */
export function createFrameQueue(run: () => void, schedule: FrameScheduler, cancelFrame: FrameCanceller) {
  let frame: number | null = null
  const cancel = () => {
    if (frame === null) return
    cancelFrame(frame)
    frame = null
  }
  return Object.freeze({
    request: () => {
      if (frame !== null) return
      frame = schedule(() => { frame = null; run() })
    },
    flush: () => { cancel(); run() },
    cancel,
  })
}
