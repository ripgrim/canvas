export function processExitDecision(kind, code) {
  if (kind === 'required-service') return Object.freeze({ stopStack: true, exitCode: code ?? 1 })
  if (kind === 'desktop-shell') return Object.freeze({ stopStack: false, exitCode: code ?? 1 })
  throw new Error(`Unknown development process kind: ${String(kind)}`)
}

export function processErrorDecision(kind) {
  if (kind === 'required-service') return Object.freeze({ stopStack: true, exitCode: 1 })
  if (kind === 'desktop-shell') return Object.freeze({ stopStack: false, exitCode: 1 })
  throw new Error(`Unknown development process kind: ${String(kind)}`)
}
