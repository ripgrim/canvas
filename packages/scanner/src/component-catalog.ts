import type { ShadcnComponentCatalog, ShadcnComponentCatalogEntry, ShadcnProp } from './contracts.js'

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.length) throw new Error(`Invalid ${label}.`)
  return value
}
const list = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}.`)
  return value
}

function scannedComponent(value: unknown): Readonly<{ path: string; exportName: string; sourceHash: string; props: readonly ShadcnProp[]; slots: readonly string[] }> {
  if (!record(value)) throw new Error('Invalid scanned component.')
  const props = list(value.props, 'scanned component props').map(prop => {
    if (!record(prop) || typeof prop.optional !== 'boolean') throw new Error('Invalid scanned component prop.')
    return { name: text(prop.name, 'scanned component prop name'), type: text(prop.type, 'scanned component prop type'), optional: prop.optional }
  })
  const slots = list(value.slots, 'scanned component slots').map(slot => text(slot, 'scanned component slot'))
  const sourceHash = text(value.sourceHash, 'scanned component source hash')
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error('Invalid scanned component source hash.')
  return { path: text(value.path, 'scanned component path'), exportName: text(value.exportName, 'scanned component export'), sourceHash, props, slots }
}

/** Derives the renderer-safe catalog shared by local and hosted repository connections. */
export function componentCatalogFromShadcnScan(scanInput: unknown, requestInput: unknown, fingerprint: string): ShadcnComponentCatalog {
  if (!record(scanInput) || !record(requestInput) || !fingerprint.trim()) throw new Error('Invalid component catalog source.')
  const scanned = new Map(list(scanInput.components, 'scanner components').map(value => {
    const component = scannedComponent(value)
    return [`${component.path}\0${component.exportName}`, component] as const
  }))
  const seen = new Set<string>()
  const components: ShadcnComponentCatalogEntry[] = list(requestInput.components, 'registry components').map(value => {
    if (!record(value) || !record(value.props)) throw new Error('Invalid registry component.')
    const componentId = text(value.componentId, 'registry component id')
    const path = text(value.entryPath, 'registry component path')
    const exportName = text(value.exportName, 'registry component export')
    if (seen.has(componentId)) throw new Error('Duplicate registry component identity.')
    seen.add(componentId)
    const source = scanned.get(`${path}\0${exportName}`)
    if (!source) throw new Error('The verified registry component is missing from the scanner result.')
    const propNames = new Set(Object.keys(value.props))
    const slots = list(value.slots, 'registry component slots').map(slot => text(slot, 'registry component slot'))
    const slotNames = new Set(slots)
    if (slotNames.size !== slots.length || [...propNames].some(name => slotNames.has(name))) throw new Error('Invalid registry component schema.')
    const props = source.props.filter(prop => propNames.has(prop.name) || slotNames.has(prop.name))
    if (props.length !== propNames.size + slotNames.size) throw new Error('The verified component schema does not match the scanner result.')
    return { componentId, path, exportName, sourceHash: source.sourceHash, props, slots }
  })
  return { fingerprint, components }
}
