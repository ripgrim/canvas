import type { InsertTarget } from './document-store'

export const componentDragMime = 'application/x-design-editor-component'

export type ComponentDragPayload = { componentId: string; target: InsertTarget }
type DragData = Pick<DataTransfer, 'getData' | 'types'>

const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(value)

export function encodeComponentDrag(payload: ComponentDragPayload): string {
  return JSON.stringify(payload)
}

export function hasComponentDrag(data: Pick<DataTransfer, 'types'>): boolean {
  return Array.from(data.types).includes(componentDragMime)
}

export function readComponentDrag(data: DragData): ComponentDragPayload | null {
  if (!hasComponentDrag(data)) return null
  const source = data.getData(componentDragMime)
  if (!source || source.length > 512) return null
  try {
    const value = JSON.parse(source) as Record<string, unknown>
    if (!value || Array.isArray(value) || Object.keys(value).some(key => !['componentId', 'target'].includes(key)) || !validId(value.componentId)) return null
    const target = value.target as Record<string, unknown>
    if (!target || Array.isArray(target) || Object.keys(target).some(key => !['parentId', 'slot', 'index'].includes(key))) return null
    if (target.parentId !== null && !validId(target.parentId)) return null
    if (target.slot !== undefined && !validId(target.slot)) return null
    if (target.index !== undefined && (!Number.isInteger(target.index) || Number(target.index) < 0)) return null
    return { componentId: value.componentId, target: { parentId: target.parentId, ...(target.slot !== undefined ? { slot: target.slot } : {}), ...(target.index !== undefined ? { index: Number(target.index) } : {}) } }
  } catch {
    return null
  }
}
