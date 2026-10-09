import { describe, expect, it } from 'vitest'
import { compareOrder, isOrderKey, orderKeyBetween, orderKeySequence } from '../src/order-keys.js'

describe('order keys', () => {
  it('opens an empty sibling list with the middle digit', () => {
    const key = orderKeyBetween(null, null)
    expect(key).toBe('V')
    expect(isOrderKey(key)).toBe(true)
  })

  it('keeps 200 consecutive appends strictly increasing and valid', () => {
    let previous: string | null = null
    const keys: string[] = []
    for (let step = 0; step < 200; step++) { previous = orderKeyBetween(previous, null); keys.push(previous) }
    for (let position = 0; position < keys.length; position++) {
      expect(isOrderKey(keys[position])).toBe(true)
      if (position > 0) expect(keys[position - 1]! < keys[position]!).toBe(true)
    }
    expect(new Set(keys).size).toBe(200)
  })

  it('keeps 200 insertions below a moving upper bound strictly decreasing and above an open lower end', () => {
    let upper = 'V'
    for (let step = 0; step < 200; step++) {
      const next = orderKeyBetween(null, upper)
      expect(isOrderKey(next)).toBe(true)
      expect(next < upper).toBe(true)
      upper = next
    }
  })

  it('keeps 200 insertions just above a fixed lower key strictly decreasing and above that lower key', () => {
    const lower = 'a'
    let upper = 'b'
    for (let step = 0; step < 200; step++) {
      const next = orderKeyBetween(lower, upper)
      expect(isOrderKey(next)).toBe(true)
      expect(next < upper).toBe(true)
      expect(next > lower).toBe(true)
      upper = next
    }
  })

  it.each([
    ['a', 'b', 'aV'],
    ['a', 'a1', 'a0V'],
    ['V', 'W', 'VV'],
    ['az', 'b', 'azV'],
    ['A', 'z', 'a'],
  ])('places a valid key strictly between %s and %s', (before, after, expected) => {
    const key = orderKeyBetween(before, after)
    expect(key).toBe(expected)
    expect(key > before && key < after).toBe(true)
    expect(isOrderKey(key)).toBe(true)
  })

  it('never produces a key ending in 0, including descents below a 0-prefixed key', () => {
    const produced = [orderKeyBetween(null, '1'), orderKeyBetween(null, '0V'), orderKeyBetween('a', 'a1'), orderKeyBetween('0z', '1')]
    expect(produced).toEqual(['0V', '0F', 'a0V', '0zV'])
    for (const key of produced) expect(key.endsWith('0')).toBe(false)
  })

  it('rejects keys ending in 0 and malformed keys as stored order keys', () => {
    expect(isOrderKey('a0')).toBe(false)
    expect(isOrderKey('')).toBe(false)
    expect(isOrderKey('a-b')).toBe(false)
    expect(isOrderKey('a'.repeat(65))).toBe(false)
    expect(isOrderKey('a1')).toBe(true)
  })

  it('throws when bounds are not increasing or not keys', () => {
    expect(() => orderKeyBetween('b', 'a')).toThrow('Order keys must be increasing')
    expect(() => orderKeyBetween('a', 'a')).toThrow('Order keys must be increasing')
    expect(() => orderKeyBetween('a!', null)).toThrow('Invalid order key')
  })

  it('breaks order key ties by node id', () => {
    const items = [{ id: 'c', orderKey: 'V' }, { id: 'b', orderKey: 'V' }, { id: 'a', orderKey: 'W' }, { id: 'z', orderKey: 'U' }]
    expect([...items].sort(compareOrder).map(item => item.id)).toEqual(['z', 'b', 'c', 'a'])
    expect(compareOrder({ id: 'x', orderKey: 'V' }, { id: 'x', orderKey: 'V' })).toBe(0)
  })

  it('generates a strictly increasing sequence', () => {
    const keys = orderKeySequence(5)
    expect(keys).toEqual(['V', 'W', 'X', 'Y', 'Z'])
    expect(orderKeySequence(0)).toEqual([])
  })
})
