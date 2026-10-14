import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const source = process.env.GOOGLE_FONT_CATALOG_URL ?? 'https://fonts.google.com/metadata/fonts'
const destination = resolve(import.meta.dirname, '../packages/editor/src/features/fonts/google-fonts.generated.json')
const response = await fetch(source)
if (!response.ok) throw new Error(`Font catalog request failed with ${response.status}.`)
const body = await response.json()
if (!body || typeof body !== 'object' || !Array.isArray(body.familyMetadataList)) throw new Error('Font catalog shape is invalid.')

const styles = entries => entries.map(value => {
  const match = /^(\d+)(i?)$/.exec(value)
  if (!match) throw new Error(`Invalid font style ${value}.`)
  return { weight: Number(match[1]), style: match[2] ? 'italic' : 'normal' }
})

const catalog = body.familyMetadataList.map(value => {
  if (!value || typeof value !== 'object' || typeof value.family !== 'string' || !value.fonts || typeof value.fonts !== 'object') throw new Error('Invalid font family.')
  return {
    family: value.family,
    styles: styles(Object.keys(value.fonts)),
    ...(Array.isArray(value.axes) && value.axes.length > 0
      ? { axes: Object.fromEntries(value.axes.map(axis => [axis.tag, { defaultValue: axis.defaultValue, max: axis.max, min: axis.min }])) }
      : {}),
  }
})

catalog.sort((left, right) => left.family.localeCompare(right.family, 'en', { numeric: true, ignorePunctuation: true }))
await writeFile(destination, `${JSON.stringify({ source, families: catalog })}\n`, 'utf8')
console.log(`Wrote ${catalog.length} Google font families.`)
