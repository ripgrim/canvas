import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const fixture = resolve('tests/fixtures/application-update')
const output = resolve('../../outputs/application-updates')
await mkdir(output, { recursive: true })
const server = await createServer({ root: fixture, server: { host: '127.0.0.1', port: 4399, strictPort: true }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 780, height: 500 }, deviceScaleFactor: 1 })
  await page.goto('http://127.0.0.1:4399/?phase=ready')
  await page.locator('.update-card').waitFor()
  await page.screenshot({ path: resolve(output, 'desktop-update-ready.png'), fullPage: true })
  await page.goto('http://127.0.0.1:4399/?phase=downloading')
  await page.locator('.update-progress').waitFor()
  await page.screenshot({ path: resolve(output, 'desktop-update-downloading.png'), fullPage: true })
  const card = await page.locator('.update-card').boundingBox()
  if (!card || card.width > 520 || card.x < 0 || card.y + card.height > 500) throw new Error('The update notice is outside its visual bounds.')
} finally {
  await browser.close()
  await server.close()
}
