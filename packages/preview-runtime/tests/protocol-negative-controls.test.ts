import { describe, expect, it } from 'vitest'
import { acceptPreviewCommand, compareFlowDragTransactionOrder, isPreviewDocument, type PreviewDocument, type PreviewFlowDragTransaction } from '../src/protocol.js'
// Protocol v4: every document node carries its effective theme; the plain light fallback is not explicit.
const lightTheme = { mode: 'light', designThemeId: 'default', attribute: null, colorScheme: 'light', explicit: false } as const

// LAY-SEC-001 baseline. Wrong origin, opaque origin, wrong sender, stale generation, extra set-props/set-document/
// set-selection/set-interaction-mode fields, unknown and prototype layout ids, and oversized props are already covered
// in protocol.test.ts; this file adds the remaining envelope and set-layout negative controls. Every rejection table
// starts from a command that is accepted, so a rejection can only come from the single mutation under test.

const editorOrigin = 'http://127.0.0.1:4319'
const parent = {} as Window
const envelope = { channel: 'design-editor-preview', version: 10, generation: 7 } as const
const deliver = (data: unknown, document: PreviewDocument | null = null) => acceptPreviewCommand({ origin: editorOrigin, source: parent, data }, editorOrigin, parent, 7, document)

const document = (): PreviewDocument => ({
  version: 3, revision: 3, rootIds: ['card-1'],
  nodes: {
    'card-1': { id: 'card-1', componentId: 'atom-card', exportName: 'Card', theme: lightTheme, props: {}, children: { children: ['button-1'] } },
    'button-1': { id: 'button-1', componentId: 'atom-button', exportName: 'Button', theme: lightTheme, props: { children: 'Go' }, children: {} },
  },
  frame: { width: 480, height: 640, direction: 'column', gap: 16, padding: 24, clip: false },
  assets: { flowers: { mime: 'image/webp', data: 'AAAA' } },
})
const item = { nodeId: 'button-1', mode: 'absolute', x: 10, y: 20, order: 0, width: 120, height: 40 }
const layout = (items: unknown[]) => ({ ...envelope, type: 'set-layout', layoutGeneration: 0, flowDragTerminalPolicy: 'preserve-matching-committed-handoff', items })
const transient = (items: unknown[]) => ({ ...envelope, type: 'set-transient-move', items })

const accepted: [string, Record<string, unknown>, PreviewDocument | null][] = [
  ['set-layout', layout([item]), document()],
  ['set-transient-move', transient([{ nodeId: 'button-1', dx: 10, dy: -20, width: 140, height: 60 }]), document()],
  ['set-theme', { ...envelope, type: 'set-theme', theme: { attribute: 'dark', colorScheme: 'dark' } }, null],
  ['set-camera', { ...envelope, type: 'set-camera', sequence: 1, camera: { x: 0, y: 0, zoom: 1, width: 800, height: 600 } }, null],
  ['set-interaction-mode', { ...envelope, type: 'set-interaction-mode', mode: 'select' }, null],
  ['set-selection', { ...envelope, type: 'set-selection', nodeIds: ['button-1'], color: '#009ff0' }, document()],
  ['set-document', { ...envelope, type: 'set-document', document: document(), flowDragTerminalPolicy: 'preserve-matching-committed-handoff' }, null],
  ['set-props', { ...envelope, type: 'set-props', props: { children: 'Go' } }, null],
  ['dispose', { ...envelope, type: 'dispose' }, null],
  ['ping', { ...envelope, type: 'ping' }, null],
]

describe('LAY-SEC-001 unknown top-level fields', () => {
  it.each(accepted)('accepts a well formed %s command as the positive control', (_, data, doc) => {
    expect(deliver(data, doc)).toEqual(data)
  })

  it.each(accepted)('rejects %s with one unknown top-level field', (_, data, doc) => {
    expect(deliver({ ...data, sourcePath: '../outside' }, doc)).toBeNull()
    expect(deliver({ ...data, token: 'secret' }, doc)).toBeNull()
  })

  it.each(accepted)('rejects %s carrying a __proto__ own key from parsed JSON', (_, data, doc) => {
    const polluted = JSON.parse(`{"__proto__":{"admin":true},${JSON.stringify(data).slice(1)}`)
    expect(Object.hasOwn(polluted, '__proto__')).toBe(true)
    expect(deliver(polluted, doc)).toBeNull()
  })

  it.each(accepted)('rejects %s with a missing channel, version, or generation', (_, data, doc) => {
    const { channel: _channel, ...noChannel } = data
    const { version: _version, ...noVersion } = data
    const { generation: _generation, ...noGeneration } = data
    expect(deliver(noChannel, doc)).toBeNull()
    expect(deliver(noVersion, doc)).toBeNull()
    expect(deliver(noGeneration, doc)).toBeNull()
    for (const staleVersion of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(deliver({ ...data, version: staleVersion }, doc)).toBeNull()
    }
    expect(deliver({ ...data, version: '10' }, doc)).toBeNull()
    expect(deliver({ ...data, generation: '7' }, doc)).toBeNull()
  })

  it('rejects the previous preview document schema even inside a current envelope', () => {
    expect(deliver({ ...envelope, type: 'set-document', document: { ...document(), version: 2 }, flowDragTerminalPolicy: 'preserve-matching-committed-handoff' })).toBeNull()
  })

  it('rejects an unknown command type and a command that is not a plain record', () => {
    expect(deliver({ ...envelope, type: 'set-styles', items: [] })).toBeNull()
    expect(deliver({ ...envelope, type: 'eval', code: 'alert(1)' })).toBeNull()
    expect(deliver([envelope])).toBeNull()
    expect(deliver(JSON.stringify(layout([item])))).toBeNull()
    expect(deliver(null)).toBeNull()
  })
})

describe('LAY-SEC-001 unknown fields inside a set-layout item', () => {
  it('accepts the base item with and without its optional size fields', () => {
    expect(deliver(layout([item]), document())).not.toBeNull()
    expect(deliver(layout([{ ...item, declarations: { transform: 'matrix(1, 0.25, -0.5, 1, 0, 0)' } }]), document())).not.toBeNull()
    const { width: _width, height: _height, ...bare } = item
    expect(deliver(layout([bare]), document())).not.toBeNull()
  })

  it('rejects legacy transform functions and translated matrices at the runtime boundary', () => {
    for (const transform of ['rotate(45deg) scale(1.5)', 'matrix(1, 0, 0, 1, 10, 20)', 'matrix(1001, 0, 0, 1, 0, 0)']) {
      expect(deliver(layout([{ ...item, declarations: { transform } }]), document())).toBeNull()
    }
  })

  it.each([
    ['a CSS string', { style: 'color: red' }],
    ['a transform', { transform: 'rotate(45deg)' }],
    ['a v4 position record', { position: { mode: 'absolute', left: { kind: 'px', value: 10 } } }],
    ['a parent id', { parentId: 'card-1' }],
    ['a slot', { slot: 'children' }],
    ['a source path', { path: 'src/atoms/Button.tsx' }],
    ['an explicit undefined field', { zIndex: undefined }],
  ])('rejects an item with %s', (_, extra) => {
    expect(deliver(layout([{ ...item, ...extra }]), document())).toBeNull()
  })

  it('rejects an item with a __proto__ own key and one bad item among good ones', () => {
    const polluted = JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(item).slice(1)}`)
    expect(deliver(layout([polluted]), document())).toBeNull()
    const second = { ...item, nodeId: 'card-1', mode: 'flow', order: 1 }
    expect(deliver(layout([item, second]), document())).not.toBeNull()
    expect(deliver(layout([item, { ...second, color: '#ff0000' }]), document())).toBeNull()
  })

  it.each([
    ['an unknown mode', { mode: 'fixed' }],
    ['a string coordinate', { x: '10' }],
    ['a NaN coordinate', { y: Number.NaN }],
    ['an infinite coordinate', { x: Number.POSITIVE_INFINITY }],
    ['a fractional order', { order: 1.5 }],
    ['a negative order', { order: -1 }],
    ['a zero width', { width: 0 }],
    ['a negative height', { height: -4 }],
    ['a string width', { width: '120px' }],
  ])('rejects an item with %s', (_, patch) => {
    expect(deliver(layout([{ ...item, ...patch }]), document())).toBeNull()
  })

  it('rejects items that are not records', () => {
    expect(deliver(layout(['button-1']), document())).toBeNull()
    expect(deliver(layout([null]), document())).toBeNull()
    expect(deliver(layout([[item]]), document())).toBeNull()
    expect(deliver({ ...envelope, type: 'set-layout', layoutGeneration: 0, items: { 0: item } }, document())).toBeNull()
  })
})

describe('LAY-SEC-001 invalid node ids in set-layout', () => {
  it('accepts the longest valid id as the positive control', () => {
    const id = `a${'b'.repeat(127)}`
    const doc = document()
    doc.nodes[id] = { id, componentId: 'atom-button', exportName: 'Button', theme: lightTheme, props: {}, children: {} }
    doc.nodes['card-1']!.children.children!.push(id)
    expect(deliver(layout([{ ...item, nodeId: id }]), doc)).not.toBeNull()
  })

  it.each([
    ['an empty id', ''],
    ['a leading space', ' button-1'],
    ['a trailing newline', 'button-1\n'],
    ['an id over 128 characters', `a${'b'.repeat(128)}`],
    ['a leading separator', '-button-1'],
    ['a CSS selector', 'button-1"]'],
    ['a path', '../button-1'],
    ['constructor', 'constructor'],
    ['prototype', 'prototype'],
    ['a number', 1],
    ['null', null],
  ])('rejects %s even without a document to check membership', (_, nodeId) => {
    expect(deliver(layout([{ ...item, nodeId }]))).toBeNull()
  })

  it('rejects a duplicate node id and an id that is valid but absent from the current document', () => {
    expect(deliver(layout([item, { ...item, order: 1 }]), document())).toBeNull()
    expect(deliver(layout([{ ...item, nodeId: 'button-2' }]), document())).toBeNull()
  })
})

describe('LAY-SEC-001 oversize set-layout payloads', () => {
  const many = (count: number) => Array.from({ length: count }, (_, index) => ({ nodeId: `node-${index}`, mode: 'flow', x: 0, y: 0, order: index % 501 }))

  it('accepts 500 items and rejects 501', () => {
    expect(deliver(layout(many(500)))).not.toBeNull()
    expect(deliver(layout(many(501)))).toBeNull()
  })

  it.each([
    ['x past 1000000', { x: 1_000_001 }, { x: 1_000_000 }],
    ['y below -1000000', { y: -1_000_001 }, { y: -1_000_000 }],
    ['width past 1000000', { width: 1_000_001 }, { width: 1_000_000 }],
    ['height past 1000000', { height: 1_000_001 }, { height: 1_000_000 }],
    ['order past 500', { order: 501 }, { order: 500 }],
  ])('rejects %s and accepts the bound itself', (_, over, bound) => {
    expect(deliver(layout([{ ...item, ...bound }]), document())).not.toBeNull()
    expect(deliver(layout([{ ...item, ...over }]), document())).toBeNull()
  })
})

describe('AT-CAN-005 transient move boundary', () => {
  const move = { nodeId: 'button-1', dx: 10, dy: -20 }

  it('accepts bounded current nodes and the empty clear command', () => {
    expect(deliver(transient([move]), document())).toEqual(transient([move]))
    expect(deliver(transient([{ ...move, width: 140, height: 60 }]), document())).toEqual(transient([{ ...move, width: 140, height: 60 }]))
    expect(deliver(transient([{ ...move, duplicate: true }]), document())).toEqual(transient([{ ...move, duplicate: true }]))
    const appearance = { fills: [{ type: 'image', assetId: 'flowers', fit: 'cover', geometry: { x: -20, y: 0, width: 180, height: 120 } }] }
    expect(deliver(transient([{ ...move, width: 140, height: 60, appearance }]), document())).toEqual(transient([{ ...move, width: 140, height: 60, appearance }]))
    expect(deliver(transient([]), null)).toEqual(transient([]))
  })

  it.each([
    ['an unknown field', { ...move, style: 'position: fixed' }],
    ['an unknown node', { ...move, nodeId: 'missing' }],
    ['a prototype key', { ...move, nodeId: '__proto__' }],
    ['a string delta', { ...move, dx: '10' }],
    ['a non-finite delta', { ...move, dy: Number.POSITIVE_INFINITY }],
    ['an over-limit delta', { ...move, dx: 1_000_001 }],
    ['a zero width', { ...move, width: 0 }],
    ['a negative height', { ...move, height: -1 }],
    ['an over-limit width', { ...move, width: 1_000_001 }],
    ['the removed rotation compatibility field', { ...move, rotationDelta: 22.5 }],
    ['a false duplicate marker', { ...move, duplicate: false }],
    ['an invalid image geometry', { ...move, appearance: { fills: [{ type: 'image', assetId: 'flowers', fit: 'cover', geometry: { x: 0, y: 0, width: 0, height: 40 } }] } }],
  ])('rejects %s', (_, candidate) => {
    expect(deliver(transient([candidate]), document())).toBeNull()
  })

  it('rejects duplicate nodes, non-array items, and more than 500 items', () => {
    expect(deliver(transient([move, move]), document())).toBeNull()
    expect(deliver({ ...envelope, type: 'set-transient-move', items: { 0: move } }, document())).toBeNull()
    expect(deliver(transient(Array.from({ length: 501 }, (_, index) => ({ nodeId: `node-${index}`, dx: 0, dy: 0 }))))).toBeNull()
  })
})

describe('PAPER-FLEX-006-PROTOCOL-V9, PAPER-FLEX-007-PROTOCOL-V9, AT-CAN-005-PROTOCOL-V9, and CLOUD-SYNC-GESTURE-001-PROTOCOL-V9', () => {
  const sourceFence = {
    fileId: 'file-1', fileRevision: 3, measurementRevision: 8, documentRevision: 3, layoutGeneration: 5,
    pageId: 'page-1', pageRootId: 'page-root-1',
  }
  const key = { interactionId: 'flow-drag-1', gestureGeneration: 2, sequence: 4 }
  const source = {
    coordinateSpace: 'world',
    quad: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }],
    aabb: { x: 0, y: 0, width: 100, height: 80 }, semanticSize: { width: 100, height: 80 },
  }
  const current = {
    coordinateSpace: 'world',
    quad: [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 100 }, { x: 10, y: 100 }],
    aabb: { x: 10, y: 20, width: 100, height: 80 }, semanticSize: { width: 100, height: 80 },
  }
  const presentation = () => ({
    kind: 'flow-drag', coordinateSpace: 'world',
    identity: { interactionId: key.interactionId, gestureGeneration: key.gestureGeneration, sampleSequence: key.sequence },
    fence: { ...sourceFence },
    retention: { kind: 'active', gestureGeneration: key.gestureGeneration, sampleSequence: key.sequence },
    pointer: { downWorld: { x: 0, y: 0 }, currentWorld: { x: 10, y: 20 } },
    original: {
      documentNodeId: 'button-1', kind: 'component', name: 'Button',
      sourceRelationship: { parentId: 'card-1', orderKey: 'V', slot: { presence: 'present', value: 'children' } },
      sourceIndex: 0, mode: 'absolute', source, current,
      sourceOffsetParentPose: {
        coordinateSpace: 'source-offset-parent', offsetParentNodeId: 'card-1',
        sourceOffsetParentPaddingToWorld: [1, 0, 0, 1, 0, 0], matrix: [1, 0, 0, 1, 10, 20],
      },
      dom: { treatment: 'unchanged', opacity: null, opacityPriority: 'normal', zIndex: null },
      namePresentation: { visible: true, anchor: 'current', pose: current },
    },
    movingVisual: { kind: 'document-node', documentNodeId: 'button-1', geometry: current },
    supportClone: null,
    target: null,
    hud: { showDimensions: false, showSelectionOutline: false, showResizeHandles: false, showRotationHandles: false, interactiveHandleLayer: false },
    mobileQuickActions: { mounted: true, hidden: true, inert: true, transition: { property: 'opacity', durationMs: 150, source: 'wonder' } },
  })
  const transaction = (operation: unknown, nextKey = key, nextFence = sourceFence) => ({ ...envelope, type: 'apply-flow-drag-transaction', transaction: { key: nextKey, sourceFence: nextFence, operation } })
  const publish = () => transaction({ kind: 'publish', presentation: presentation() })
  const tombstone = (nextKey = key) => transaction({ kind: 'tombstone' }, nextKey)
  const handoff = () => transaction({
    kind: 'committed-handoff',
    committed: {
      previewGeneration: 7, fileId: 'file-1', pageId: 'page-1', pageRootId: 'page-root-1',
      documentRevision: 4, layoutGeneration: 6, afterMeasurementRevision: 9, terminalSequence: 4,
    },
  })

  it('accepts the literal peer-renderable presentation, keyed tombstone, and committed terminal handoff', () => {
    expect(deliver(publish(), document())).toEqual(publish())
    expect(deliver(publish(), null)).toBeNull()
    expect(deliver(tombstone(), document())).toEqual(tombstone())
    expect(deliver(handoff(), document())).toEqual(handoff())
  })

  it('accepts the Paper flow ghost without granting it a document identity', () => {
    const flow = presentation()
    flow.original.mode = 'flow'
    flow.original.sourceOffsetParentPose = null
    flow.original.dom = { treatment: 'drag-dimmed', opacity: 0.6, opacityPriority: 'important', zIndex: null }
    flow.original.namePresentation = { visible: true, anchor: 'source', pose: source }
    flow.movingVisual = {
      kind: 'fill-ghost', documentNodeId: null, geometry: current,
      fill: { kind: 'fill-only', color: 'oklch(0.67 0.17 258)', alpha: 0.15 }, hitTesting: 'none', a11y: 'hidden',
    }
    expect(deliver(transaction({ kind: 'publish', presentation: flow }), document())).not.toBeNull()
    expect(deliver(transaction({ kind: 'publish', presentation: { ...flow, movingVisual: { ...flow.movingVisual, documentNodeId: 'ghost-1' } } }), document())).toBeNull()
  })

  it('accepts a proved transformed-parent pose that retains authored rotation and reflection', () => {
    const transformed = presentation()
    const world = {
      coordinateSpace: 'world',
      quad: [{ x: 110, y: 221 }, { x: 110, y: 521 }, { x: 270, y: 521 }, { x: 270, y: 221 }],
      aabb: { x: 110, y: 221, width: 160, height: 300 }, semanticSize: { width: 100, height: 80 },
    }
    transformed.pointer = { downWorld: { x: 0, y: 0 }, currentWorld: { x: 0, y: 0 } }
    transformed.original.source = world
    transformed.original.current = world
    transformed.original.sourceOffsetParentPose = {
      coordinateSpace: 'source-offset-parent', offsetParentNodeId: 'card-1',
      sourceOffsetParentPaddingToWorld: [2, 0, 0, 3, 100, 200], matrix: [0, 1, 1, 0, 5, 7],
    }
    transformed.original.namePresentation = { visible: true, anchor: 'current', pose: world }
    transformed.movingVisual = { kind: 'document-node', documentNodeId: 'button-1', geometry: world }
    expect(deliver(transaction({ kind: 'publish', presentation: transformed }), document())).not.toBeNull()
  })

  it('makes terminal preservation explicit on every document and layout replacement', () => {
    expect(deliver({ ...envelope, type: 'set-document', document: document() })).toBeNull()
    expect(deliver({ ...envelope, type: 'set-document', document: document(), flowDragTerminalPolicy: 'clear' })).toBeNull()
    expect(deliver({ ...envelope, type: 'set-document', document: document(), flowDragTerminalPolicy: 'preserve' })).toBeNull()
    expect(deliver({ ...envelope, type: 'set-document', document: document(), flowDragTerminalPolicy: 'preserve-matching-committed-handoff' })).not.toBeNull()
    expect(deliver({ ...envelope, type: 'set-layout', layoutGeneration: 0, items: [] }, document())).toBeNull()
    expect(deliver({ ...envelope, type: 'set-layout', layoutGeneration: 0, items: [], flowDragTerminalPolicy: 'clear' }, document())).toBeNull()
    expect(deliver({ ...envelope, type: 'set-layout', layoutGeneration: 0, items: [], flowDragTerminalPolicy: 'preserve' }, document())).toBeNull()
    expect(deliver({ ...envelope, type: 'set-layout', layoutGeneration: 0, items: [], flowDragTerminalPolicy: 'preserve-matching-committed-handoff' }, document())).not.toBeNull()
  })

  it('rejects v7 envelopes, stale preview generations, wrong fences, and mismatched identities', () => {
    expect(deliver({ ...publish(), version: 7 }, document())).toBeNull()
    expect(deliver({ ...publish(), generation: 6 }, document())).toBeNull()
    expect(deliver(transaction({ kind: 'publish', presentation: { ...presentation(), identity: { ...presentation().identity, sampleSequence: 5 } } }), document())).toBeNull()
    expect(deliver(transaction({ kind: 'publish', presentation: { ...presentation(), fence: { ...sourceFence, measurementRevision: 9 } } }), document())).toBeNull()
    expect(deliver(transaction({ kind: 'publish', presentation: { ...presentation(), original: { ...presentation().original, documentNodeId: 'missing' } } }), document())).toBeNull()
    expect(deliver(transaction({ kind: 'publish', presentation: { ...presentation(), original: { ...presentation().original, sourceRelationship: { ...presentation().original.sourceRelationship, parentId: 'wrong-parent' } } } }), document())).toBeNull()
    expect(deliver(transaction({ kind: 'publish', presentation: { ...presentation(), original: { ...presentation().original, kind: 'frame' } } }), document())).toBeNull()
    expect(deliver(transaction({ kind: 'publish', presentation: { ...presentation(), original: { ...presentation().original, sourceIndex: 999 } } }), document())).toBeNull()
    expect(deliver(transaction({ kind: 'publish', presentation: { ...presentation(), original: { ...presentation().original, sourceRelationship: { ...presentation().original.sourceRelationship, slot: { presence: 'present', value: 'wrong-slot' } } } } }), document())).toBeNull()
    expect(deliver(transaction({ kind: 'publish', presentation: { ...presentation(), original: { ...presentation().original, sourceOffsetParentPose: { ...presentation().original.sourceOffsetParentPose!, offsetParentNodeId: null } } } }), document())).toBeNull()
    expect(deliver(transaction({ kind: 'publish', presentation: { ...presentation(), original: { ...presentation().original, sourceOffsetParentPose: { ...presentation().original.sourceOffsetParentPose!, matrix: [1, 0, 0, 1, 999, 999] } } } }), document())).toBeNull()
    expect(deliver(transaction({ kind: 'publish', presentation: { ...presentation(), original: { ...presentation().original, sourceOffsetParentPose: { ...presentation().original.sourceOffsetParentPose!, sourceOffsetParentPaddingToWorld: [1, 0, 0, 1, 500, 500] } } } }), document())).toBeNull()
  })

  it('rejects copied authority, support clone identity, and any document-like clone authority', () => {
    expect(deliver(transaction({ kind: 'publish', presentation: { ...presentation(), authority: { kind: 'copied', mutable: true } } }), document())).toBeNull()
    const clone = {
      key: { kind: 'flow-support-clone', interactionId: key.interactionId, gestureGeneration: key.gestureGeneration, cloneGeneration: 1 },
      documentNodeId: null, generation: 1,
      sourceRelationship: { parentId: 'card-1', orderKey: 'V', slot: { presence: 'present', value: 'children' } },
      sourceIndex: 0, entryMode: 'flow', entry: null, world: source, hiddenUntilCommit: true,
      role: 'inert-marker', layoutParticipation: 'none', hitTesting: 'none', a11y: 'hidden',
    }
    expect(deliver(transaction({ kind: 'publish', presentation: { ...presentation(), supportClone: clone } }), document())).not.toBeNull()
    expect(deliver(transaction({ kind: 'publish', presentation: { ...presentation(), supportClone: { ...clone, documentNodeId: 'clone-1' } } }), document())).toBeNull()
    expect(deliver(transaction({ kind: 'publish', presentation: { ...presentation(), supportClone: { ...clone, layerId: 'clone-1' } } }), document())).toBeNull()
    expect(deliver(transaction({ kind: 'publish', presentation: { ...presentation(), supportClone: { ...clone, historyId: 'clone-1' } } }), document())).toBeNull()
    expect(deliver(transaction({ kind: 'publish', presentation: { ...presentation(), supportClone: { ...clone, layoutParticipation: 'flow' } } }), document())).toBeNull()
  })

  it('rejects unsafe or unbounded integers and non-finite or singular absolute poses', () => {
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY]) {
      expect(deliver(tombstone({ ...key, sequence: invalid }), document())).toBeNull()
      expect(deliver(tombstone({ ...key, gestureGeneration: invalid }), document())).toBeNull()
    }
    for (const matrix of [[1, 0, 0, 0, 10, 20], [1, 0, 0, 1, Number.NaN, 20], [1, 0, 0, 1, 1_000_001, 20]]) {
      const next = presentation()
      next.original.sourceOffsetParentPose.matrix = matrix
      expect(deliver(transaction({ kind: 'publish', presentation: next }), document())).toBeNull()
    }
  })

  it('rejects a handoff with stale identity, generation, or revision evidence', () => {
    const valid = handoff().transaction.operation.committed
    for (const committed of [
      { ...valid, previewGeneration: 6 }, { ...valid, fileId: 'file-2' }, { ...valid, pageId: 'page-2' }, { ...valid, pageRootId: 'root-2' },
      { ...valid, documentRevision: 3 }, { ...valid, layoutGeneration: 4 }, { ...valid, afterMeasurementRevision: 8 }, { ...valid, terminalSequence: 5 },
    ]) expect(deliver(transaction({ kind: 'committed-handoff', committed }), document())).toBeNull()
  })

  it('does not mutate any accepted or rejected transaction input', () => {
    const accepted = publish()
    const acceptedBytes = JSON.stringify(accepted)
    expect(deliver(accepted, document())).not.toBeNull()
    expect(JSON.stringify(accepted)).toBe(acceptedBytes)
    const rejected = transaction({ kind: 'publish', presentation: { ...presentation(), copiedAuthority: true } })
    const rejectedBytes = JSON.stringify(rejected)
    expect(deliver(rejected, document())).toBeNull()
    expect(JSON.stringify(rejected)).toBe(rejectedBytes)
  })

  it('fails closed on hidden, symbol, and accessor fields before invoking a getter', () => {
    const hidden = publish()
    Object.defineProperty(hidden.transaction.operation.presentation.identity, 'hidden', { value: true, enumerable: false })
    expect(deliver(hidden, document())).toBeNull()

    const symbolic = publish()
    Object.defineProperty(symbolic.transaction.operation.presentation.original, Symbol('authority'), { value: true, enumerable: true })
    expect(deliver(symbolic, document())).toBeNull()

    let reads = 0
    const accessor = publish()
    Object.defineProperty(accessor.transaction.operation.presentation.identity, 'interactionId', { enumerable: true, get: () => { reads += 1; return key.interactionId } })
    expect(deliver(accessor, document())).toBeNull()
    expect(reads).toBe(0)

    const arrayAccessor = publish()
    Object.defineProperty(arrayAccessor.transaction.operation.presentation.original.sourceOffsetParentPose.matrix, '0', { enumerable: true, get: () => { reads += 1; return 1 } })
    expect(deliver(arrayAccessor, document())).toBeNull()
    expect(reads).toBe(0)
  })

  it('orders by interaction plus gesture generation and gives same-sequence tombstones terminal precedence', () => {
    const acceptedPublish = publish().transaction as PreviewFlowDragTransaction
    const acceptedHandoff = handoff().transaction as PreviewFlowDragTransaction
    const acceptedTombstone = tombstone().transaction as PreviewFlowDragTransaction
    const staleClear = tombstone({ ...key, gestureGeneration: 1, sequence: 99 }).transaction as PreviewFlowDragTransaction
    const newerPublish = transaction({ kind: 'publish', presentation: { ...presentation(), identity: { ...presentation().identity, sampleSequence: 5 }, retention: { kind: 'active', gestureGeneration: 2, sampleSequence: 5 } } }, { ...key, sequence: 5 }).transaction as PreviewFlowDragTransaction
    expect(compareFlowDragTransactionOrder(acceptedPublish, acceptedHandoff)).toBe(1)
    expect(compareFlowDragTransactionOrder(acceptedHandoff, acceptedTombstone)).toBe(1)
    expect(compareFlowDragTransactionOrder(acceptedTombstone, acceptedPublish)).toBe(-1)
    expect(compareFlowDragTransactionOrder(newerPublish, staleClear)).toBe(-1)
    expect(compareFlowDragTransactionOrder(staleClear, newerPublish)).toBe(1)
    expect(compareFlowDragTransactionOrder(acceptedTombstone, { ...acceptedPublish, key: { ...acceptedPublish.key, interactionId: 'other' } })).toBeNull()
    expect(compareFlowDragTransactionOrder(acceptedTombstone, { ...acceptedPublish, sourceFence: { ...acceptedPublish.sourceFence, measurementRevision: 9 } })).toBeNull()
  })
})

describe('PAPER-FLEX-006, PAPER-FLEX-007, AT-CAN-006, and CLOUD-SYNC-GESTURE-001 v9 transient presentation boundary', () => {
  const fence = { documentRevision: 1, layoutGeneration: 3, measurementRevision: 8 }
  const move = { kind: 'move-world', coordinateSpace: 'world', interactionId: 'drag-1', sampleSequence: 4, fence, items: [{ nodeId: 'button-1', dx: 10, dy: -20 }] }
  const resize = { kind: 'resize-parent-padding', coordinateSpace: 'parent-padding', interactionId: 'resize-1', sampleSequence: 5, fence, items: [{ nodeId: 'button-1', parentNodeId: 'card-1', startRect: { x: 1, y: 2, width: 30, height: 40 }, rect: { x: 5, y: -15, width: 35, height: 50 }, nodeTransform: [1, 0, 0, 1, 0, 0], transformOrigin: { x: 17.5, y: 25 } }] }
  const command = (presentations: unknown[]) => ({ ...envelope, type: 'set-transient-presentations', presentations })

  it('accepts strict world and parent-padding presentations plus an empty clear', () => {
    expect(deliver(command([move]), document())).toEqual(command([move]))
    expect(deliver(command([resize]), document())).toEqual(command([resize]))
    expect(deliver(command([]), null)).toEqual(command([]))
  })

  it('rejects missing, extra, inherited, forbidden, and wrong discriminator fields at every new boundary', () => {
    const { items: _items, ...missingItems } = move
    const inherited = Object.assign(Object.create({ injected: true }), move)
    const ownPrototype = JSON.parse(`{"__proto__":{"polluted":true},${JSON.stringify(move).slice(1)}`)
    const { width: _width, ...partialRect } = resize.items[0]!.rect
    const mutations = [
      { ...move, sourcePath: '../outside' },
      missingItems,
      inherited,
      ownPrototype,
      { ...move, coordinateSpace: 'parent-padding' },
      { ...move, kind: 'resize-parent-padding' },
      { ...move, items: [{ ...move.items[0], width: 40 }] },
      { ...resize, coordinateSpace: 'world' },
      { ...resize, kind: 'move-world' },
      { ...resize, items: [{ ...resize.items[0], dx: 0 }] },
      { ...resize, items: [{ ...resize.items[0], rect: partialRect }] },
      { ...resize, items: [{ ...resize.items[0], rect: { ...resize.items[0]!.rect, worldX: 30 } }] },
      { ...resize, fence: { ...fence, token: 'secret' } },
      { ...resize, fence: { documentRevision: 1, layoutGeneration: 3 } },
    ]
    for (const mutation of mutations) expect(deliver(command([mutation]), document())).toBeNull()
    expect(deliver({ ...command([move]), token: 'secret' }, document())).toBeNull()
    expect(deliver({ ...command([move]), version: 6 }, document())).toBeNull()
  })

  it('rejects unsafe numbers, empty samples, duplicate identities, and limit overruns', () => {
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, 1_000_001, -1_000_001]) {
      expect(deliver(command([{ ...move, items: [{ ...move.items[0], dx: invalid }] }]), document())).toBeNull()
      expect(deliver(command([{ ...resize, items: [{ ...resize.items[0], rect: { ...resize.items[0]!.rect, x: invalid } }] }]), document())).toBeNull()
    }
    for (const invalid of [0, -1, 1_000_001, Number.NaN]) {
      expect(deliver(command([{ ...resize, items: [{ ...resize.items[0], rect: { ...resize.items[0]!.rect, width: invalid } }] }]), document())).toBeNull()
    }
    expect(deliver(command([{ ...resize, items: [{ ...resize.items[0], nodeTransform: [1, 0, 0, 0, 0, 0] }] }]), document())).toBeNull()
    expect(deliver(command([{ ...resize, items: [{ ...resize.items[0], nodeTransform: [1, 0, 0, 1, 1, 0] }] }]), document())).toBeNull()
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(deliver(command([{ ...move, sampleSequence: invalid }]), document())).toBeNull()
      expect(deliver(command([{ ...move, fence: { ...fence, measurementRevision: invalid } }]), document())).toBeNull()
    }
    expect(deliver(command([{ ...move, items: [] }]), document())).toBeNull()
    expect(deliver(command([move, { ...move, items: [{ nodeId: 'card-1', dx: 0, dy: 0 }] }]), document())).toBeNull()
    expect(deliver(command([move, { ...resize, interactionId: 'resize-2', items: [{ ...resize.items[0], nodeId: 'button-1' }] }]), document())).toBeNull()
    expect(deliver(command([{ ...move, items: Array.from({ length: 501 }, (_, index) => ({ nodeId: `node-${index}`, dx: 0, dy: 0 })) }]), document())).toBeNull()
    const tooMany = Array.from({ length: 501 }, (_, index) => ({ ...move, interactionId: `drag-${index}`, items: [{ nodeId: `node-${index}`, dx: 0, dy: 0 }] }))
    expect(deliver(command(tooMany), document())).toBeNull()
  })

  it('rejects unknown nodes, stale parent topology, bad appearance assets, and raw-world double-projection shapes', () => {
    expect(deliver(command([{ ...move, items: [{ nodeId: 'missing', dx: 0, dy: 0 }] }]), document())).toBeNull()
    expect(deliver(command([{ ...resize, items: [{ ...resize.items[0], parentNodeId: null }] }]), document())).toBeNull()
    expect(deliver(command([{ ...resize, items: [{ ...resize.items[0], parentNodeId: 'missing' }] }]), document())).toBeNull()
    const staleTopology = document()
    staleTopology.rootIds.push('button-1')
    expect(deliver(command([resize]), staleTopology)).toBeNull()
    const badAppearance = { fills: [{ type: 'image', assetId: 'missing', fit: 'cover', geometry: { x: 0, y: 0, width: 10, height: 10 } }] }
    expect(deliver(command([{ ...resize, items: [{ ...resize.items[0], appearance: badAppearance }] }]), document())).toBeNull()
    const worldMutation = { nodeId: 'button-1', parentNodeId: 'card-1', startRect: { x: 1, y: 2, width: 30, height: 40 }, worldRect: { x: 30, y: 10, width: 100, height: 70 } }
    expect(deliver(command([{ ...resize, items: [worldMutation] }]), document())).toBeNull()
  })

  it('permits only reviewed image geometry changes and rejects fill substitution on the wire boundary', () => {
    const authoritative = document()
    authoritative.assets = {
      flowers: { mime: 'image/webp', data: 'AAAA' },
      alternate: { mime: 'image/webp', data: 'BBBB' },
    }
    authoritative.nodes['button-1']!.appearance = {
      opacity: 0.8,
      fills: [
        { type: 'solid', color: '#112233' },
        { type: 'image', assetId: 'flowers', fit: 'cover', geometry: { x: 0, y: 0, width: 30, height: 40 } },
      ],
    }
    const reviewed = {
      opacity: 0.8,
      fills: [
        { type: 'solid', color: '#112233' },
        { type: 'image', assetId: 'flowers', fit: 'cover', geometry: { x: 5, y: 6, width: 35, height: 45 } },
      ],
    }
    const withAppearance = (appearance: unknown) => command([{ ...resize, items: [{ ...resize.items[0], appearance }] }])
    expect(deliver(withAppearance(reviewed), authoritative)).toEqual(withAppearance(reviewed))
    const mutations = [
      { ...reviewed, fills: [reviewed.fills[1]] },
      { ...reviewed, fills: [{ type: 'solid', color: '#112233' }, { type: 'solid', color: '#445566' }] },
      { ...reviewed, fills: [reviewed.fills[1], reviewed.fills[0]] },
      { ...reviewed, fills: [reviewed.fills[0], { ...reviewed.fills[1], assetId: 'alternate' }] },
      { ...reviewed, fills: [reviewed.fills[0], { ...reviewed.fills[1], fit: 'contain' }] },
      { ...reviewed, fills: [{ type: 'solid', color: '#ffffff' }, reviewed.fills[1]] },
    ]
    for (const mutation of mutations) expect(deliver(withAppearance(mutation), authoritative)).toBeNull()
  })

  it('enforces the one-megabyte serialized command cap independently of bounded appearances', () => {
    const large = document()
    large.rootIds = []
    large.nodes = {}
    large.canvas = { elements: [] }
    const color = 'oklch(0.123456789012345678901234 0.123456789012345678901234 120.123456789012345678901234 / 0.123456789012345678901234)'
    const appearance = { fills: Array.from({ length: 16 }, () => ({ type: 'gradient', shape: 'linear', angle: 0, center: { x: 0.5, y: 0.5 }, length: 1, interpolation: 'srgb', stops: Array.from({ length: 16 }, (_, index) => ({ color, position: index / 15 })) })) }
    const presentations = Array.from({ length: 500 }, (_, index) => {
      const nodeId = `node-${index}`
      large.canvas!.elements.push({ id: nodeId, kind: 'rectangle', name: nodeId, relativeTransform: [1, 0, 0, 1, 0, 0], width: 10, height: 10, parentId: null, appearance })
      return { ...resize, interactionId: `resize-${index}`, items: [{ ...resize.items[0], nodeId, parentNodeId: null, appearance }] }
    })
    expect(JSON.stringify(command(presentations)).length).toBeGreaterThan(1_000_000)
    expect(deliver(command(presentations), large)).toBeNull()
  })
})

describe('LAY-SEC-001 appearance layer priority conflicts', () => {
  it.todo('LAY-SEC-001: the appearance layer reports when an !important stylesheet rule overrides an inline appearance value (no conflict check or diagnostic exists; appearance-layer.mjs only restores inline priorities)')
  // The layout layer now preserves inline priorities and reports stylesheet !important conflicts; see layout-root-baseline.test.ts (LAY-ROOT-001) and layout-runtime.test.ts (LAY-ROOT-002).
})

describe('PAPER-FLEX-003 freeform primitive sizing grammar', () => {
  const primitiveDocument = (name: string, value: string): PreviewDocument => ({
    ...document(),
    canvas: {
      elements: [
        { id: 'frame', kind: 'frame', name: 'Frame', relativeTransform: [1, 0, 0, 1, 0, 0], width: 300, height: 200, parentId: null },
        { id: 'shape', kind: 'shape', name: 'Shape', relativeTransform: [1, 0, 0, 1, 10, 10], width: 80, height: 60, parentId: 'frame', layout: { mode: 'freeform', declarations: { [name]: value } } },
      ],
    },
  })

  it.each(['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height'])('rejects unsafe %s values independently', name => {
    for (const value of ['calc(100% - 2px)', 'var(--size)', 'url(https://invalid.test/x)', '42%;position:fixed']) {
      expect(isPreviewDocument(primitiveDocument(name, value))).toBe(false)
    }
  })

  it.each(['inline-size', 'block-size', 'contain-intrinsic-width', 'constructor'])('rejects the unknown %s sizing authority', name => {
    expect(isPreviewDocument(primitiveDocument(name, '42%'))).toBe(false)
  })
})
