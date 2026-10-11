import { chromium } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { waitForThumbnailResources } from '../src/index.js'

let browser: Awaited<ReturnType<typeof chromium.launch>>

beforeAll(async () => { browser = await chromium.launch({ headless: true }) })
afterAll(async () => { await browser?.close() })

describe('thumbnail resource readiness', () => {
  it('AT-THUMB-001 waits for document fonts before capture', async () => {
    const page = await browser.newPage()
    try {
      await page.setContent('<main>Fixture</main>')
      await page.evaluate(() => {
        Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: new Promise(resolve => window.setTimeout(resolve, 80)) } })
      })
      const started = Date.now()
      await waitForThumbnailResources(page, 1_000)
      expect(Date.now() - started).toBeGreaterThanOrEqual(60)
    } finally { await page.close() }
  })

  it('AT-THUMB-001 waits for pending image decode before capture', async () => {
    const page = await browser.newPage()
    try {
      await page.setContent('<img alt="fixture" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">')
      await page.evaluate(() => {
        const image = document.images[0]!
        image.decode = () => new Promise(resolve => window.setTimeout(resolve, 80))
      })
      const started = Date.now()
      await waitForThumbnailResources(page, 1_000)
      expect(Date.now() - started).toBeGreaterThanOrEqual(60)
    } finally { await page.close() }
  })

  it('AT-THUMB-001 rejects failed image decode and bounds a stalled resource wait', async () => {
    const page = await browser.newPage()
    try {
      await page.setContent('<img alt="fixture" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">')
      await page.evaluate(() => { document.images[0]!.decode = () => Promise.reject(new Error('fixture decode failure')) })
      await expect(waitForThumbnailResources(page, 1_000)).rejects.toThrow('Thumbnail image could not be decoded')
      await page.evaluate(() => { document.images[0]!.decode = () => new Promise(() => undefined) })
      await expect(waitForThumbnailResources(page, 50)).rejects.toThrow('Thumbnail resources timed out')
    } finally { await page.close() }
  })
})
