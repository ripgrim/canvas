export type ColorRailDirection = 'forward' | 'reverse'

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value))

/** Maps a color value to its visual top-to-bottom rail position. */
export function colorRailPosition(value: number, maximum: number, direction: ColorRailDirection): number {
  if (!Number.isFinite(value) || !Number.isFinite(maximum) || maximum <= 0) return 0
  const progress = clamp(value / maximum, 0, 1)
  return (direction === 'reverse' ? 1 - progress : progress) * 100
}

/** Maps a pointer's vertical position back to the color value shown under it. */
export function colorRailValue(clientY: number, top: number, height: number, maximum: number, direction: ColorRailDirection): number {
  if (![clientY, top, height, maximum].every(Number.isFinite) || height <= 0 || maximum <= 0) return 0
  const progress = clamp((clientY - top) / height, 0, 1)
  return Math.round((direction === 'reverse' ? 1 - progress : progress) * maximum)
}
