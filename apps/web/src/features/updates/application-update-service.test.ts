import { describe, expect, it, vi } from 'vitest'
import { ApplicationUpdateService } from './application-update-service'
import type { UpdateEnvironment } from './application-update-service'

const environment = (buildId = 'build-a'): UpdateEnvironment & { fetchManifest: ReturnType<typeof vi.fn<() => Promise<{ buildId: string; version: string; commit: string | null }>>> } => ({
  buildId,
  version: '1.0.0',
  fetchManifest: vi.fn(async () => ({ buildId, version: '1.0.0', commit: null })),
  reload: vi.fn(),
  now: vi.fn(() => 1_000_000),
  setTimeout: vi.fn(() => 1),
  clearTimeout: vi.fn(),
  addWindowListener: vi.fn(),
  removeWindowListener: vi.fn(),
})

describe('WEB-UPDATE-001 web build detection', () => {
  it('distinguishes a current build from a new deployment', async () => {
    const current = environment()
    const service = new ApplicationUpdateService()
    service.configureWeb(current)
    service.start()
    await service.check()
    expect(service.getSnapshot().status).toBe('idle')

    current.fetchManifest.mockResolvedValue({ buildId: 'build-b', version: '1.0.1', commit: 'abc' })
    await service.check()
    expect(service.getSnapshot()).toMatchObject({ status: 'ready', availableVersion: '1.0.1', kind: 'web' })
  })

  it('does not report a failed request as up to date', async () => {
    const current = environment()
    current.fetchManifest.mockRejectedValue(new Error('offline'))
    const service = new ApplicationUpdateService()
    service.configureWeb(current)
    service.start()
    await service.check()
    expect(service.getSnapshot()).toMatchObject({ status: 'error', retryable: true })
  })
})
