import { describe, expect, it, vi } from 'vitest'
import { createBlankFile } from '@canvas/repo-engine/file-document'
import type { HostedProjectionAdmissionResult } from './document-store'
import { createDocumentStore } from './document-store'
import { createHostedComponentAdmissionService } from './hosted-component-admission-service'
import type { HostedSourceBindingState } from './hosted-source-binding-service'
import type { HostedSourceBindingProjection } from './hosted-source-binding-projection'

const context = (projectId = 'project-1', fileId = 'file-1') => ({ projectId, fileId })
const projection = (version = 1, projectId = 'project-1'): HostedSourceBindingProjection => ({
  authority: {
    version,
    projectId,
    repositoryId: 'repository-1',
    scanId: `scan-${version}`,
    sourceRevision: `source-${version}`,
    registryFingerprint: `registry-${version}`,
    grantGeneration: 1,
    adapterId: 'adapter-1',
    updatedAt: version,
  },
  components: [{ bindingId: 'binding:button', status: 'bound', name: 'Button', props: [], slots: [] }],
})
const ready = (version = 1, projectId = 'project-1', fileId = 'file-1'): HostedSourceBindingState => ({
  status: 'ready', context: context(projectId, fileId), projection: projection(version, projectId), error: null,
})

function source(initial: HostedSourceBindingState) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => value,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    },
    set(next: HostedSourceBindingState) { value = next; for (const listener of [...listeners]) listener() },
    publish() { for (const listener of [...listeners]) listener() },
    listenerCount: () => listeners.size,
  }
}

function documents(initial: Readonly<{ fileId: string; revision: number }> | null = { fileId: 'file-1', revision: 1 }) {
  let file = initial
  const listeners = new Set<() => void>()
  const reconcileHostedProjection = vi.fn<(
    input: Readonly<{ expectedFileId: string; expectedFileRevision: number; projection: HostedSourceBindingProjection }>,
  ) => HostedProjectionAdmissionResult>(() => 'applied')
  const retireHostedProjection = vi.fn<(
    input: Readonly<{ expectedFileId: string; expectedFileRevision: number }>,
  ) => HostedProjectionAdmissionResult>(() => 'applied')
  return {
    source: {
      getSnapshot: () => ({ file }),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      commands: { components: { reconcileHostedProjection, retireHostedProjection } },
    },
    reconcileHostedProjection,
    retireHostedProjection,
    set(next: typeof file) { file = next; for (const listener of [...listeners]) listener() },
    publish() { for (const listener of [...listeners]) listener() },
    setFileWithoutPublishing(next: typeof file) { file = next },
    listenerCount: () => listeners.size,
  }
}

describe('COMP-V2-ADMISSION-001 hosted component admission lifecycle', () => {
  it('admits one exact ready projection into its matching open file', () => {
    const bindings = source(ready())
    const docs = documents()
    const service = createHostedComponentAdmissionService(bindings.source, docs.source)

    service.start()

    expect(docs.reconcileHostedProjection).toHaveBeenCalledOnce()
    expect(docs.reconcileHostedProjection).toHaveBeenCalledWith({
      expectedFileId: 'file-1', expectedFileRevision: 1, projection: projection(),
    })
    expect(docs.retireHostedProjection).not.toHaveBeenCalled()
    service.dispose()
  })

  it('restores transient atoms when the same file reloads at the same hosted version', () => {
    const bindings = source(ready())
    const docs = documents()
    const service = createHostedComponentAdmissionService(bindings.source, docs.source)
    service.start()
    docs.reconcileHostedProjection.mockClear()

    docs.set({ fileId: 'file-1', revision: 40 })

    expect(docs.reconcileHostedProjection).toHaveBeenCalledOnce()
    expect(docs.reconcileHostedProjection).toHaveBeenCalledWith({
      expectedFileId: 'file-1', expectedFileRevision: 40, projection: projection(),
    })
    service.dispose()
  })

  it('does not reconcile again for view-only document emissions on the admitted FileDocument object', () => {
    const bindings = source(ready())
    const docs = documents()
    const service = createHostedComponentAdmissionService(bindings.source, docs.source)
    service.start()
    docs.reconcileHostedProjection.mockClear()

    docs.publish()
    docs.publish()

    expect(docs.reconcileHostedProjection).not.toHaveBeenCalled()
    service.dispose()
  })

  it('COMP-V2-CODE-002 and COMP-V2-UI-NEG-001 admit and retire through the real document store while retaining the source definition', () => {
    const bindings = source(ready())
    const docs = createDocumentStore()
    docs.load(createBlankFile('file-1', 'page-1', 'root-1'), [], { replace: true, pageId: 'page-1' })
    const service = createHostedComponentAdmissionService(bindings.source, docs)

    service.start()

    expect(docs.getSnapshot().atoms).toEqual([{
      componentId: 'binding:button', kind: 'hosted', status: 'bound', name: 'Button', candidates: [], props: [], slots: [],
    }])
    expect(docs.getSnapshot().file?.componentModel.definitions['binding:button']).toMatchObject({
      id: 'binding:button', name: 'Button', source: { kind: 'code', bindingId: 'binding:button' },
    })

    bindings.set({ status: 'access-removed', context: context(), projection: null, error: null })

    expect(docs.getSnapshot().atoms).toEqual([])
    expect(docs.getSnapshot().file?.componentModel.definitions['binding:button']).toMatchObject({
      id: 'binding:button', name: 'Button', source: { kind: 'code', bindingId: 'binding:button' },
    })
    service.dispose()
    docs.dispose()
  })

  it.each(['loading', 'stale', 'error'] as const)('AT-SYNC-001 retains last-good admission through a same-context %s state', status => {
    const bindings = source(ready())
    const docs = documents()
    const service = createHostedComponentAdmissionService(bindings.source, docs.source)
    service.start()
    docs.retireHostedProjection.mockClear()

    bindings.set({ status, context: context(), projection: status === 'loading' ? projection() : null, error: status === 'loading' ? null : 'Unavailable' })

    expect(docs.retireHostedProjection).not.toHaveBeenCalled()
    service.dispose()
  })

  it('reconciles a newer ready authority even after retaining last-good through loading', () => {
    const bindings = source(ready())
    const docs = documents()
    const service = createHostedComponentAdmissionService(bindings.source, docs.source)
    service.start()
    docs.reconcileHostedProjection.mockClear()
    bindings.set({ status: 'loading', context: context(), projection: projection(), error: null })

    bindings.set(ready(2))

    expect(docs.reconcileHostedProjection).toHaveBeenCalledOnce()
    expect(docs.reconcileHostedProjection.mock.calls[0]![0].projection.authority.version).toBe(2)
    service.dispose()
  })
})

describe('COMP-V2-ADMISSION-NEG-001 hosted component retirement fences', () => {
  it.each([
    ['access removal', { status: 'access-removed', context: context(), projection: null, error: null }],
    ['empty authority', { status: 'empty', context: context(), projection: null, error: null }],
    ['idle authority', { status: 'idle', context: null, projection: null, error: null }],
    ['file context switch', { status: 'loading', context: context('project-1', 'file-2'), projection: null, error: null }],
    ['project context switch', { status: 'loading', context: context('project-2', 'file-1'), projection: null, error: null }],
  ] as const)('retires transient atoms on %s while preserving definitions in the document command', (_label, next) => {
    const bindings = source(ready())
    const docs = documents()
    const service = createHostedComponentAdmissionService(bindings.source, docs.source)
    service.start()
    docs.retireHostedProjection.mockClear()

    bindings.set(next)

    expect(docs.retireHostedProjection).toHaveBeenCalledOnce()
    expect(docs.retireHostedProjection).toHaveBeenCalledWith({ expectedFileId: 'file-1', expectedFileRevision: 1 })
    service.dispose()
  })

  it.each([
    ['mismatched file', ready(1, 'project-1', 'file-2')],
    ['mismatched authority project', { ...ready(), projection: projection(1, 'project-other') }],
  ] as const)('rejects a %s without admitting it', (_label, state) => {
    const bindings = source(state)
    const docs = documents()
    const service = createHostedComponentAdmissionService(bindings.source, docs.source)

    service.start()

    expect(docs.reconcileHostedProjection).not.toHaveBeenCalled()
    expect(docs.retireHostedProjection).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('retries a stale admission once with fresh document state under unchanged exact binding authority', () => {
    const bindings = source(ready())
    const docs = documents()
    docs.reconcileHostedProjection.mockImplementationOnce(() => {
      docs.setFileWithoutPublishing({ fileId: 'file-1', revision: 2 })
      return 'stale'
    }).mockReturnValueOnce('applied')
    const service = createHostedComponentAdmissionService(bindings.source, docs.source)

    service.start()

    expect(docs.reconcileHostedProjection).toHaveBeenCalledTimes(2)
    expect(docs.reconcileHostedProjection.mock.calls.map(call => call[0].expectedFileRevision)).toEqual([1, 2])
    service.dispose()
  })

  it('does not retry a stale authority after it changes, then admits the new ready version', () => {
    const bindings = source(ready())
    const docs = documents()
    docs.reconcileHostedProjection.mockImplementationOnce(() => {
      bindings.set(ready(2))
      docs.setFileWithoutPublishing({ fileId: 'file-1', revision: 2 })
      return 'stale'
    })
    const service = createHostedComponentAdmissionService(bindings.source, docs.source)

    service.start()

    expect(docs.reconcileHostedProjection).toHaveBeenCalledTimes(2)
    expect(docs.reconcileHostedProjection.mock.calls.map(call => call[0].projection.authority.version)).toEqual([1, 2])
    service.dispose()
  })

  it('retries stale retirement once only while the retirement intent remains current', () => {
    const bindings = source(ready())
    const docs = documents()
    const service = createHostedComponentAdmissionService(bindings.source, docs.source)
    service.start()
    docs.retireHostedProjection.mockClear()
    docs.retireHostedProjection.mockImplementationOnce(() => {
      docs.setFileWithoutPublishing({ fileId: 'file-1', revision: 2 })
      return 'stale'
    }).mockReturnValueOnce('applied')

    bindings.set({ status: 'access-removed', context: context(), projection: null, error: null })

    expect(docs.retireHostedProjection).toHaveBeenCalledTimes(2)
    expect(docs.retireHostedProjection.mock.calls.map(call => call[0].expectedFileRevision)).toEqual([1, 2])
    service.dispose()
  })

  it('cancels stale retirement retry when ready authority returns', () => {
    const bindings = source(ready())
    const docs = documents()
    const service = createHostedComponentAdmissionService(bindings.source, docs.source)
    service.start()
    docs.retireHostedProjection.mockClear()
    docs.retireHostedProjection.mockImplementationOnce(() => {
      bindings.set(ready(2))
      docs.setFileWithoutPublishing({ fileId: 'file-1', revision: 2 })
      return 'stale'
    })

    bindings.set({ status: 'access-removed', context: context(), projection: null, error: null })

    expect(docs.retireHostedProjection).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('does not reenter when a document command synchronously publishes', () => {
    const bindings = source(ready())
    const docs = documents()
    docs.reconcileHostedProjection.mockImplementation(() => { docs.publish(); return 'applied' })
    const service = createHostedComponentAdmissionService(bindings.source, docs.source)

    service.start()

    expect(docs.reconcileHostedProjection).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('retires on cleanup and owns subscriptions idempotently', () => {
    const bindings = source(ready())
    const docs = documents()
    const service = createHostedComponentAdmissionService(bindings.source, docs.source)
    service.start()
    docs.retireHostedProjection.mockClear()

    service.stop()
    service.dispose()

    expect(docs.retireHostedProjection).toHaveBeenCalledOnce()
    expect(bindings.listenerCount()).toBe(0)
    expect(docs.listenerCount()).toBe(0)
  })
})
