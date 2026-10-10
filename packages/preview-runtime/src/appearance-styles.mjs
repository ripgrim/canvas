/** CSS radius projection shared by primitive nodes and imported component roots. */

const number = value => String(Number(value.toFixed(4)))
const px = value => `${number(value)}px`

/**
 * Returns only authored radius properties. An absent appearance value must not erase an imported component's own
 * radius; an explicit zero remains `0px` and therefore does erase it without adding a wrapper.
 */
export function cornerRadiiStyle(appearance) {
  const value = appearance?.cornerRadii
  if (!value) return {}
  if (Object.hasOwn(value, 'all')) return { borderRadius: px(value.all) }
  return { borderRadius: [value.topLeft, value.topRight, value.bottomRight, value.bottomLeft].map(px).join(' ') }
}
