import { describe, expect, it } from 'vitest'
import {
  decodeSemanticCommandFromPersistence,
  encodeSemanticCommandForPersistence,
  parseCollaborationClientMessage,
  validateSemanticFileCommand,
} from '../src/index.js'

const command = (align: string) => ({
  type: 'node.setLayout',
  nodeId: 'frame-1',
  layout: {
    item: { position: { mode: 'freeform' } },
    container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align } },
  },
})

describe('PAPER-FLEX-007/008 last baseline collaboration serialization', () => {
  it('preserves exact last baseline through wire parsing and durable persistence encoding', () => {
    const semantic = command('last baseline')
    expect(validateSemanticFileCommand(semantic)).toEqual(semantic)

    const message = {
      type: 'operation.submit',
      operation: { mutationId: 'mutation-baseline-1', baseSequence: '12', command: semantic },
    }
    const parsed = parseCollaborationClientMessage(JSON.stringify(message))
    expect(parsed).toEqual(message)

    const persisted = encodeSemanticCommandForPersistence(semantic)
    expect(persisted).toEqual({
      operationType: 'node.setLayout',
      operationPayload: {
        nodeId: 'frame-1',
        layout: {
          item: { position: { mode: 'freeform' } },
          container: { display: 'flex', flex: { direction: 'row', wrap: 'nowrap', justify: 'start', align: 'last baseline' } },
        },
      },
    })
    expect(decodeSemanticCommandFromPersistence(JSON.parse(JSON.stringify(persisted)))).toEqual(semantic)
  })

  it.each(['last-baseline', 'first baseline', 'Last baseline'])('rejects unsupported alignment %s before wire or persistence acceptance', align => {
    const semantic = command(align)
    expect(() => validateSemanticFileCommand(semantic)).toThrow('Invalid semantic file command')
    expect(() => encodeSemanticCommandForPersistence(semantic)).toThrow('Invalid semantic file command')
    expect(() => parseCollaborationClientMessage(JSON.stringify({
      type: 'operation.submit',
      operation: { mutationId: 'mutation-baseline-1', baseSequence: '12', command: semantic },
    }))).toThrow('Invalid semantic operation')
  })
})
