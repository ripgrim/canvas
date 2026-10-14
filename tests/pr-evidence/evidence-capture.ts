import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import type { ResolvedCaptureCrop, ResolvedScreenshotOptions } from "../../packages/editor-automation/dist/index.js"
import type { PlaywrightEvidencePort } from "../../packages/editor-automation/dist/playwright.js"

export function evidencePort<CheckpointName extends string>(root: string, frameTimes: number[]): PlaywrightEvidencePort<CheckpointName> {
  return Object.freeze({
    async screenshot(name, page, options) {
      await mkdir(root, { recursive: true })
      const bytes = options.crop || options.scale === 2
        ? await captureCompositorScreenshot(page, options)
        : await page.screenshot({ animations: "disabled", caret: "hide" })
      await writeFile(join(root, `${name}.png`), bytes)
    },
    async record(page, options, run) {
      await mkdir(root, { recursive: true })
      await writeFile(join(root, "recording.json"), `${JSON.stringify(options, null, 2)}\n`)
      if (options.crop) await writeFile(join(root, "poster.png"), await captureCompositorScreenshot(page, { crop: options.crop, scale: 2 }))
      await page.screencast.start({
        path: join(root, "raw.webm"),
        onFrame: frame => frameTimes.push(frame.timestamp),
      })
      try {
        return await run()
      } finally {
        await page.screencast.stop()
      }
    },
  })
}

async function captureCompositorScreenshot(page: Page, options: ResolvedScreenshotOptions): Promise<Buffer> {
  const viewport = options.crop?.viewport ?? page.viewportSize() ?? await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const crop = options.crop ?? fullViewportCrop(viewport)
  const session = await page.context().newCDPSession(page)
  let data: string
  try {
    const result = await session.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: crop.source.x, y: crop.source.y, width: crop.source.width, height: crop.source.height, scale: options.scale },
    })
    data = result.data
  } finally {
    await session.detach()
  }
  if (crop.source.width === crop.output.width && crop.source.height === crop.output.height && crop.output.offsetX === 0 && crop.output.offsetY === 0) return Buffer.from(data, "base64")
  const composed = await page.evaluate(async input => {
    const bytes = Uint8Array.from(atob(input.data), character => character.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }))
    const canvas = document.createElement("canvas")
    canvas.width = input.output.width * input.scale
    canvas.height = input.output.height * input.scale
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Screenshot compositor is unavailable.")
    context.fillStyle = input.background
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, input.output.offsetX * input.scale, input.output.offsetY * input.scale)
    bitmap.close()
    return canvas.toDataURL("image/png").slice("data:image/png;base64,".length)
  }, { data, output: crop.output, background: crop.background, scale: options.scale })
  return Buffer.from(composed, "base64")
}

function fullViewportCrop(viewport: Readonly<{ width: number; height: number }>): ResolvedCaptureCrop {
  return Object.freeze({
    viewport,
    source: Object.freeze({ x: 0, y: 0, width: viewport.width, height: viewport.height }),
    output: Object.freeze({ width: viewport.width, height: viewport.height, offsetX: 0, offsetY: 0 }),
    background: "#ffffff",
  })
}

export async function writeCaptureReport(root: string, frameTimes: readonly number[]): Promise<void> {
  const raw = await readFile(join(root, "raw.webm"))
  if (!raw.byteLength) throw new Error("Evidence recording is empty.")
  await writeFile(join(root, "capture.json"), `${JSON.stringify({
    sourceFrames: frameTimes.length,
    durationMs: frameTimes.length > 1 ? frameTimes.at(-1)! - frameTimes[0]! : 0,
    sha256: createHash("sha256").update(raw).digest("hex"),
  }, null, 2)}\n`)
}
