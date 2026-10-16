import type { ShadcnComponent, ShadcnComponentCatalog, ShadcnComponentCatalogEntry, ShadcnPreviewPropRule, ShadcnProp, ShadcnSourceSymbolEvidence } from './contracts.js'
import { compareText } from './ordering.js'
import { shadcnPreviewPropRule } from './preview-prop-rule.js'
import { parseShadcnPreviewRegistryRequest, parseShadcnScan } from './strict-contract.js'

const bindingPackagePattern = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,126}\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const bindingPathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/
const bindingSymbolPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/
const bindingExportPattern = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/

function invalid(message: string): never {
  throw new Error(message)
}

function bindingText(value: string, pattern: RegExp, label: string, maximum: number): string {
  if (value.length < 1 || value.length > maximum || value.trim() !== value || !pattern.test(value)) invalid(`Invalid ${label}.`)
  return value
}

function base64Digest(hex: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes = Array.from({ length: hex.length / 2 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16))
  let result = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    result += alphabet[first >> 2]
    result += alphabet[(first & 3) << 4 | (second ?? 0) >> 4]
    result += second === undefined ? '=' : alphabet[(second & 15) << 2 | (third ?? 0) >> 6]
    result += third === undefined ? '=' : alphabet[third & 63]
  }
  return result
}

function canonicalProps(props: readonly ShadcnProp[]): readonly ShadcnProp[] {
  return [...props].sort((left, right) => compareText(left.name, right.name))
}

function canonicalRules(rules: Readonly<Record<string, ShadcnPreviewPropRule>>): Readonly<Record<string, ShadcnPreviewPropRule>> {
  return Object.fromEntries(Object.entries(rules).sort(([left], [right]) => compareText(left, right)))
}

function expectedRules(component: ShadcnComponent): Readonly<Record<string, ShadcnPreviewPropRule>> {
  const slotNames = new Set(component.slots)
  const entries = component.props.filter(prop => !slotNames.has(prop.name)).map(prop => {
    const rule = shadcnPreviewPropRule(prop.type, prop.optional)
    if (!rule) invalid('The scanned component needs an explicit prop adapter.')
    return [prop.name, rule] as const
  })
  return canonicalRules(Object.fromEntries(entries))
}

/**
 * Publishes immutable scanner evidence in the repository binding shape.
 * Components without an unambiguous package owner or binding-safe locator fail closed.
 */
export function componentCatalogFromShadcnScan(scanInput: unknown, requestInput: unknown, fingerprint: string): ShadcnComponentCatalog {
  const scan = parseShadcnScan(scanInput)
  const request = parseShadcnPreviewRegistryRequest(requestInput)
  if (typeof fingerprint !== 'string' || !fingerprint.length || fingerprint.length > 512 || fingerprint.trim() !== fingerprint || /[\u0000-\u001f\u007f]/u.test(fingerprint)) invalid('Invalid component catalog fingerprint.')

  const scanned = new Map<string, ShadcnComponent>()
  for (const component of scan.components) {
    const locator = `${component.path}\0${component.exportName}`
    if (scanned.has(locator)) invalid('Duplicate scanned component locator.')
    scanned.set(locator, component)
  }

  const identities = new Set<string>()
  const locators = new Set<string>()
  const components: ShadcnComponentCatalogEntry[] = request.components.map(component => {
    const symbolKey = bindingText(component.componentId, bindingSymbolPattern, 'source symbol key', 128)
    const componentPath = bindingText(component.entryPath, bindingPathPattern, 'source path', 1_000)
    const locator = `${componentPath}\0${component.exportName}`
    if (identities.has(symbolKey)) invalid('Duplicate registry component identity.')
    if (locators.has(locator)) invalid('Duplicate registry component locator.')
    identities.add(symbolKey)
    locators.add(locator)

    const source = scanned.get(locator)
    if (!source) invalid('The verified registry component is missing from the scanner result.')
    if (source.packageName === null) invalid('The scanned component needs an explicit package owner.')
    const packageName = bindingText(source.packageName, bindingPackagePattern, 'source package name', 128)
    const exportName = bindingText(source.exportName, bindingExportPattern, 'source export name', 128)
    if (component.integrity !== `sha256-${base64Digest(source.sourceHash)}`) invalid('The verified component integrity does not match the scanner result.')
    if (JSON.stringify(component.slots) !== JSON.stringify(source.slots)) invalid('The verified component slots do not match the scanner result.')
    if (JSON.stringify(canonicalRules(component.props)) !== JSON.stringify(expectedRules(source))) invalid('The verified component props do not match the scanner result.')

    return {
      componentId: symbolKey,
      symbolKey,
      packageName,
      path: componentPath,
      exportName,
      sourceHash: source.sourceHash,
      fingerprint: source.fingerprint,
      props: canonicalProps(source.props),
      slots: source.slots,
    }
  }).sort((left, right) => compareText(left.path, right.path) || compareText(left.exportName, right.exportName) || compareText(left.symbolKey, right.symbolKey))

  return { fingerprint, components }
}

/** Removes preview-only catalog fields before evidence crosses the repository binding boundary. */
export function sourceSymbolEvidenceFromCatalogEntry(entry: ShadcnComponentCatalogEntry): ShadcnSourceSymbolEvidence {
  return Object.freeze({
    symbolKey: entry.symbolKey,
    packageName: entry.packageName,
    path: entry.path,
    exportName: entry.exportName,
    sourceHash: entry.sourceHash,
    fingerprint: entry.fingerprint,
  })
}
