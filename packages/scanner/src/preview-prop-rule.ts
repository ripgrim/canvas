import type { ShadcnPreviewPropRule } from './contracts.js'

function stringLiteralValue(source: string): string | undefined {
  const value = source.trim()
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    try { return JSON.parse(value.startsWith("'") ? `"${value.slice(1, -1).replaceAll('"', '\\"')}"` : value) as string } catch { return undefined }
  }
  return undefined
}

export function shadcnPreviewPropRule(source: string, optional: boolean): ShadcnPreviewPropRule | null {
  const members = source.split('|').map(member => member.trim()).filter(member => member !== 'undefined' && member !== 'null')
  if (members.length === 1 && (members[0] === 'string' || members[0] === 'boolean')) return { kind: members[0], optional }
  const values = members.map(stringLiteralValue)
  if (values.length && values.every((value): value is string => value !== undefined)) return { kind: 'enum', values, optional }
  return null
}
