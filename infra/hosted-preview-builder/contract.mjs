export function hostedPreviewDefaultProps(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return Object.fromEntries(Object.entries(value).flatMap(([name, candidate]) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) invalid()
    const allowed = candidate.kind === 'enum' ? ['kind', 'optional', 'values'] : ['kind', 'optional']
    if (Object.keys(candidate).some(key => !allowed.includes(key)) || typeof candidate.optional !== 'boolean') invalid()
    if (candidate.optional) return []
    if (candidate.kind === 'string') return [[name, name]]
    if (candidate.kind === 'number') return [[name, 0]]
    if (candidate.kind === 'boolean') return [[name, false]]
    if (candidate.kind === 'enum' && Array.isArray(candidate.values) && candidate.values.length) return [[name, candidate.values[0]]]
    invalid()
  }))
}

function invalid() {
  throw new Error('Build contract is invalid.')
}
