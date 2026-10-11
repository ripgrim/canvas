import { chromium } from '@playwright/test'
import { describe, expect, it } from 'vitest'

const onePixelAvif = 'AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAAA5waXRtAAAAAAABAAAAImlsb2MAAAAAREAAAQABAAAAAAD6AAEAAAAAAAAAHwAAACNpaW5mAAAAAAABAAAAFWluZmUCAAAAAAEAAGF2MDEAAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgUBsAAAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwwMDAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAAnbWRhdBIACghYAAY0BDQbhDIRGAAOOOOEAACwE1TtMKTrDPw='

describe('FILE-ASSET-001 AVIF runtime support', () => {
  it('decodes the real AVIF bytes accepted by the preview protocol', async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true })
    try {
      const page = await browser.newPage()
      const dimensions = await page.evaluate(async data => {
        const image = new Image()
        image.src = `data:image/avif;base64,${data}`
        await image.decode()
        return { width: image.naturalWidth, height: image.naturalHeight }
      }, onePixelAvif)
      expect(dimensions).toEqual({ width: 1, height: 1 })
    } finally { await browser.close() }
  })
})
