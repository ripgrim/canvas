export type FailureDetails = Readonly<{
  message: string
  reference: string
  code: string
}>

const referencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const codePattern = /^[a-z][a-z0-9_]{0,79}$/

function field(error: unknown, key: 'requestId' | 'reference' | 'code'): unknown {
  return error && typeof error === 'object' ? (error as Record<string, unknown>)[key] : undefined
}

export function failureDetails(error: unknown, fallback: string): FailureDetails {
  const candidateReference = field(error, 'requestId') ?? field(error, 'reference')
  const candidateCode = field(error, 'code')
  const message = error instanceof Error && error.message.trim() && error.message.length <= 300 ? error.message : fallback
  return Object.freeze({
    message,
    reference: typeof candidateReference === 'string' && referencePattern.test(candidateReference) ? candidateReference : crypto.randomUUID(),
    code: typeof candidateCode === 'string' && codePattern.test(candidateCode) ? candidateCode : 'unexpected_error',
  })
}
