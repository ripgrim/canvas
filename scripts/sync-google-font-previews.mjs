import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dirname, '..')
const catalogPath = resolve(root, 'packages/editor/src/features/fonts/google-fonts.generated.json')
const metadataPath = resolve(root, 'packages/editor/src/features/fonts/google-font-previews.generated.json')
const assetsPath = resolve(root, 'packages/editor/src/features/fonts/google-font-previews')
const assetsModulePath = resolve(root, 'packages/editor/src/features/fonts/google-font-preview-assets.generated.ts')
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
const families = catalog.families.map(entry => entry.family)
const cellWidth = 256
const cellHeight = 32
const atlasWidth = 1024
const atlasHeight = 1024
const columns = atlasWidth / cellWidth
const rows = atlasHeight / cellHeight
const perAtlas = columns * rows
const atlasCount = Math.ceil(families.length / perAtlas)
const previewText = [...new Set(families.join(''))].join('')

await rm(assetsPath, { force: true, recursive: true })
await mkdir(assetsPath, { recursive: true })

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.setContent(`<main>${Array.from({ length: atlasCount }, (_, index) => `<canvas data-atlas="${index}" width="${atlasWidth}" height="${atlasHeight}"></canvas>`).join('')}</main>`)

const previews = []
for (let offset = 0; offset < families.length; offset += 32) {
  const batch = families.slice(offset, offset + 32)
  const params = new URLSearchParams({ display: 'block', text: previewText })
  for (const family of batch) params.append('family', family)
  const response = await fetch(`https://fonts.googleapis.com/css2?${params}`, { headers: { 'user-agent': 'Mozilla/5.0 Chrome/153 Safari/537.36' } })
  if (!response.ok) throw new Error(`Font preview stylesheet returned ${response.status}.`)
  await page.addStyleTag({ content: await response.text() })
  const rendered = await page.evaluate(async ({ batch, offset, cellWidth, cellHeight, columns, perAtlas }) => {
    const output = []
    for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
      const family = batch[batchIndex]
      const faces = await document.fonts.load(`28px ${JSON.stringify(family)}`)
      const index = offset + batchIndex
      const atlas = Math.floor(index / perAtlas)
      const slot = index % perAtlas
      const x = (slot % columns) * cellWidth
      const y = Math.floor(slot / columns) * cellHeight
      const canvas = document.querySelector(`canvas[data-atlas="${atlas}"]`)
      const context = canvas.getContext('2d')
      context.font = `28px ${JSON.stringify(family)}`
      context.fillStyle = '#000'
      context.textBaseline = 'alphabetic'
      const width = Math.min(cellWidth - 8, Math.ceil(context.measureText(family).width) + 4)
      if (faces.length > 0) context.fillText(family, x + 2, y + 26, cellWidth - 8)
      output.push({ family, atlas, x, y, width, available: faces.length > 0 })
    }
    return output
  }, { batch, offset, cellWidth, cellHeight, columns, perAtlas })
  previews.push(...rendered)
  process.stdout.write(`\rRendered ${Math.min(offset + batch.length, families.length)} of ${families.length}`)
}

for (let atlas = 0; atlas < atlasCount; atlas += 1) {
  const dataUrl = await page.locator(`canvas[data-atlas="${atlas}"]`).evaluate(canvas => canvas.toDataURL('image/webp', 0.9))
  await writeFile(resolve(assetsPath, `font-chunk-${atlas}.webp`), Buffer.from(dataUrl.split(',')[1], 'base64'))
}
await browser.close()

const metadata = Object.fromEntries(previews.filter(preview => preview.available).map(({ family, atlas, x, y, width }) => [family, { atlas, x, y, width }]))
await writeFile(metadataPath, `${JSON.stringify({ atlasWidth, atlasHeight, cellHeight, families: metadata })}\n`, 'utf8')
const assetLines = Array.from({ length: atlasCount }, (_, atlas) => `  new URL('./google-font-previews/font-chunk-${atlas}.webp', import.meta.url).href,`).join('\n')
await writeFile(assetsModulePath, `export const googleFontPreviewAssets = [\n${assetLines}\n] as const\n`, 'utf8')
process.stdout.write(`\nWrote ${Object.keys(metadata).length} previews across ${atlasCount} atlases.\n`)
