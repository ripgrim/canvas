import { describe, expect, it, vi } from 'vitest'
import { createFrameQueue } from './frame-queue'

describe('AT-PERF-001 preview frame queue', () => {
  it('projects one latest-state update for a burst of inspector input', () => {
    let callback: (() => void) | null = null
    const run = vi.fn()
    const cancel = vi.fn()
    const queue = createFrameQueue(run, next => { callback = next; return 41 }, cancel)
    for (let input = 0; input < 120; input++) queue.request()
    expect(run).not.toHaveBeenCalled()
    callback!()
    expect(run).toHaveBeenCalledTimes(1)

    queue.request()
    queue.flush()
    expect(cancel).toHaveBeenCalledWith(41)
    expect(run).toHaveBeenCalledTimes(2)

    queue.request()
    queue.cancel()
    expect(cancel).toHaveBeenCalledTimes(2)
  })
})
