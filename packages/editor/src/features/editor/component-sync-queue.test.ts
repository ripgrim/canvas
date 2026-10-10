import { afterEach, describe, expect, it, vi } from 'vitest'
import { componentSyncQueue } from './component-sync-queue'

afterEach(() => componentSyncQueue.reset())

describe('component sync queue', () => {
  it('deduplicates browser component use by stable component id', () => {
    componentSyncQueue.queueBrowserUse('file-a', 'button')
    componentSyncQueue.queueBrowserUse('file-a', 'button')
    componentSyncQueue.queueBrowserUse('file-a', 'card')
    expect(componentSyncQueue.pendingComponentIds('file-a')).toEqual(['button', 'card'])
  })

  it('does not claim a request was queued without a desktop transport', async () => {
    await expect(componentSyncQueue.submit({ fileId: 'file-a', componentIds: ['button'], sourceLocation: 'components/ui/button.tsx', destination: 'packages/ui' })).resolves.toBe(false)
  })

  it('hands a complete request to the configured desktop transport', async () => {
    const enqueue = vi.fn(async () => undefined)
    componentSyncQueue.configure({ enqueue })
    const request = { fileId: 'file-a', componentIds: ['button'], sourceLocation: 'components/ui/button.tsx', destination: 'packages/ui' }
    await expect(componentSyncQueue.submit(request)).resolves.toBe(true)
    expect(enqueue).toHaveBeenCalledWith(request)
  })
})
