import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fileLocation = vi.hoisted(() => ({
  openLocation: vi.fn(),
  openSharedLocation: vi.fn(),
}))

vi.mock('@canvas/editor/file-route', async () => {
  const actual = await vi.importActual<typeof import('@canvas/editor/file-route')>('@canvas/editor/file-route')
  return { ...actual, fileLocationStore: fileLocation }
})

import { fileOpenProgressService } from './file-open-progress-service'
import { loadFileRoute } from './file-route-service'

const input = {
  params: { fileId: '11111111-2222-4333-8444-555555555555' },
  deps: { pageId: null },
  location: { search: {} },
}

describe('FILE-OPEN-SLOW-001 route progress', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fileOpenProgressService.cancel()
    fileLocation.openLocation.mockReset()
    fileLocation.openSharedLocation.mockReset()
  })

  afterEach(() => {
    fileOpenProgressService.cancel()
    vi.useRealTimers()
  })

  it('shows slow progress without manufacturing a failure', async () => {
    let resolveOpen: ((result: { status: 'error'; message: string; reference: string }) => void) | undefined
    fileLocation.openLocation.mockImplementation((_fileId, _pageId, _nodeId, signal: AbortSignal) => new Promise(resolve => {
      resolveOpen = resolve
      expect(signal.aborted).toBe(false)
    }))

    const pending = loadFileRoute(input, 5)
    expect(fileOpenProgressService.getSnapshot()).toMatchObject({ fileId: input.params.fileId, status: 'opening' })
    await vi.advanceTimersByTimeAsync(5)
    expect(fileOpenProgressService.getSnapshot()).toMatchObject({ fileId: input.params.fileId, status: 'slow' })

    resolveOpen?.({ status: 'error', message: 'The collaboration service rejected the connection.', reference: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' })
    await expect(pending).resolves.toEqual({ status: 'error', message: 'The collaboration service rejected the connection.', reference: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' })
    expect(fileOpenProgressService.getSnapshot().status).toBe('idle')
    expect(fileLocation.openSharedLocation).not.toHaveBeenCalled()
  })

  it('cancels the active attempt and returns progress to idle', async () => {
    let signal: AbortSignal | undefined
    fileLocation.openLocation.mockImplementation((_fileId, _pageId, _nodeId, nextSignal: AbortSignal) => {
      signal = nextSignal
      return new Promise(() => undefined)
    })

    void loadFileRoute(input, 5)
    await vi.advanceTimersByTimeAsync(5)
    fileOpenProgressService.cancel()

    expect(signal?.aborted).toBe(true)
    expect(fileOpenProgressService.getSnapshot().status).toBe('idle')
  })
})
