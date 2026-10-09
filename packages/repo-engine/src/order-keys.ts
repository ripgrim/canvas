/**
 * Fractional order keys for sibling ordering. Keys compare as plain strings; a midpoint always exists between two
 * neighbours, so moving one node never rewrites its siblings. Ties (two siblings sharing a key) break by node id.
 */
const digits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const base = digits.length
const middleDigit = digits[Math.floor(base / 2)]!
export const orderKeyPattern = /^[0-9A-Za-z]{1,64}$/
/** Keys never end in `0`: `x` and `x0` would otherwise be equal in the digit model yet distinct strings. */
export const isOrderKey = (value: unknown): value is string => typeof value === 'string' && orderKeyPattern.test(value) && !value.endsWith('0')

/** A key strictly above `key` (digit-string successor that stays short). */
function above(key: string): string {
  if (key === '') return middleDigit
  for (let position = 0; position < key.length; position++) {
    const digit = digits.indexOf(key[position]!)
    if (digit < base - 1) return key.slice(0, position) + digits[digit + 1]
  }
  return key + middleDigit
}

/** A key strictly between `before` and `after`; either bound may be null for an open end. */
export function orderKeyBetween(before: string | null, after: string | null): string {
  const low = before ?? ''
  if (before !== null && !orderKeyPattern.test(before) || after !== null && !orderKeyPattern.test(after)) throw new Error('Invalid order key')
  if (after !== null && low >= after) throw new Error('Order keys must be increasing')
  if (after === null) return above(low)
  let prefix = 0
  while (prefix < low.length && prefix < after.length && low[prefix] === after[prefix]) prefix++
  const common = after.slice(0, prefix)
  const lowDigit = prefix < low.length ? digits.indexOf(low[prefix]!) : -1
  const highDigit = digits.indexOf(after[prefix]!)
  if (highDigit - lowDigit > 1) {
    const middle = lowDigit + Math.ceil((highDigit - lowDigit) / 2)
    if (middle > 0) return common + digits[middle]
  }
  // Adjacent digits: keep the lower digit and move strictly above the remainder of `before` at the next depth.
  if (lowDigit >= 0) return common + digits[lowDigit] + above(low.slice(prefix + 1))
  // `before` is exhausted: open a `0` digit below `after`, then either a fresh middle or a descent into `after`'s remainder.
  if (highDigit > 0) return common + digits[0] + middleDigit
  const tail = after.slice(prefix + 1)
  if (!tail) throw new Error('Invalid order key')
  return common + after[prefix] + orderKeyBetween(null, tail)
}

/** Evenly spaced keys for `count` siblings placed at once. */
export function orderKeySequence(count: number): string[] {
  const keys: string[] = []
  let previous: string | null = null
  for (let position = 0; position < count; position++) { previous = orderKeyBetween(previous, null); keys.push(previous) }
  return keys
}

/** Sort comparator for siblings: order key first, identity as a deterministic tie-break. */
export const compareOrder = (left: { orderKey: string; id: string }, right: { orderKey: string; id: string }) => left.orderKey < right.orderKey ? -1 : left.orderKey > right.orderKey ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0
