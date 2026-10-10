import type { FileEdit, JsonObject, JsonValue, PathSegment } from '@canvas/sync-protocol'

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])
const own = (value: object, key: string | number) => Object.hasOwn(value, key)

function safeSegment(segment: PathSegment): void {
  if (typeof segment === 'string' && forbiddenKeys.has(segment)) throw new Error('Unsafe edit path')
  if (typeof segment === 'number' && (!Number.isSafeInteger(segment) || segment < 0)) throw new Error('Invalid array index')
}

function child(container: JsonValue, segment: PathSegment): JsonValue {
  safeSegment(segment)
  if (Array.isArray(container)) {
    if (typeof segment !== 'number' || segment >= container.length) throw new Error('Edit path does not exist')
    return container[segment]!
  }
  if (container === null || typeof container !== 'object' || typeof segment !== 'string' || !own(container, segment)) throw new Error('Edit path does not exist')
  return container[segment]!
}

function parentAt(root: JsonObject, path: readonly PathSegment[]): { parent: JsonValue; key: PathSegment } {
  if (!path.length) throw new Error('An edit path cannot be empty')
  let current: JsonValue = root
  for (const segment of path.slice(0, -1)) current = child(current, segment)
  return { parent: current, key: path[path.length - 1]! }
}

function setAt(root: JsonObject, path: readonly PathSegment[], value: JsonValue): void {
  const { parent, key } = parentAt(root, path)
  safeSegment(key)
  if (Array.isArray(parent)) {
    if (typeof key !== 'number' || key > parent.length) throw new Error('Invalid array index')
    if (key === parent.length) parent.push(structuredClone(value)); else parent[key] = structuredClone(value)
    return
  }
  if (parent === null || typeof parent !== 'object' || typeof key !== 'string') throw new Error('Edit target is not an object')
  parent[key] = structuredClone(value)
}

function deleteAt(root: JsonObject, path: readonly PathSegment[]): void {
  const { parent, key } = parentAt(root, path)
  safeSegment(key)
  if (Array.isArray(parent)) {
    if (typeof key !== 'number' || key >= parent.length) throw new Error('Edit path does not exist')
    parent.splice(key, 1)
    return
  }
  if (parent === null || typeof parent !== 'object' || typeof key !== 'string' || !own(parent, key)) throw new Error('Edit path does not exist')
  delete parent[key]
}

function spliceAt(root: JsonObject, edit: Extract<FileEdit, { type: 'splice' }>): void {
  let target: JsonValue = root
  for (const segment of edit.path) target = child(target, segment)
  if (!Array.isArray(target) || edit.index > target.length || edit.deleteCount > target.length - edit.index) throw new Error('Invalid splice range')
  target.splice(edit.index, edit.deleteCount, ...structuredClone(edit.values))
}

/** Generic JSON application for fixtures and adapters. Production repositories must validate the resulting editor schema. */
export function applyFileEdits(input: JsonObject, edits: readonly FileEdit[]): JsonObject {
  const result = structuredClone(input)
  for (const edit of edits) {
    if (edit.type === 'set') setAt(result, edit.path, edit.value)
    else if (edit.type === 'delete') deleteAt(result, edit.path)
    else spliceAt(result, edit)
  }
  return result
}
