import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { CDPSession, Page } from "@playwright/test"
import type { ResolvedCaptureCrop, ResolvedRecordingOptions, ResolvedScreenshotOptions } from "../../packages/editor-automation/dist/index.js"
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
      if (options.quality.mode === "compositor") return recordCompositor(page, root, options, frameTimes, run)
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

async function recordCompositor<Result>(
  page: Page,
  root: string,
  options: ResolvedRecordingOptions & { crop: ResolvedCaptureCrop; quality: { mode: "compositor"; scale: 1 | 2; fps: 12 | 24 | 30 } },
  frameTimes: number[],
  run: () => Promise<Result>,
): Promise<Result> {
  const directory = join(root, "compositor-frames")
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  const frames: Array<{ path: string; timestamp: number }> = []
  const session = await page.context().newCDPSession(page)
  let active = true
  let captureFailure: unknown
  const capture = async (timestamp: number) => {
    if (frames.length >= 300) throw new Error("Compositor recordings are limited to 300 frames.")
    const path = join(directory, `${frames.length.toString().padStart(6, "0")}.png`)
    const bytes = await captureCompositorScreenshot(page, { crop: options.crop, scale: options.quality.scale }, session)
    await writeFile(path, bytes)
    frames.push({ path, timestamp })
    frameTimes.push(timestamp)
  }
  let timestamp = await page.evaluate(() => performance.now())
  await capture(timestamp)
  const captureLoop = async () => {
    while (active) {
      timestamp = await nextBrowserFrame(page, timestamp + 1000 / options.quality.fps)
      if (active) await capture(timestamp)
    }
  }
  const capturing = captureLoop().catch(error => {
    captureFailure = error
  })
  let result: Result | undefined
  let runFailure: unknown
  try {
    result = await run()
  } catch (error) {
    runFailure = error
  } finally {
    active = false
    await capturing
    if (!captureFailure) await capture(await page.evaluate(() => performance.now())).catch(error => {
      captureFailure = error
    })
    await session.detach()
  }
  if (runFailure) throw runFailure
  if (captureFailure) throw captureFailure
  await writeFile(join(root, "poster.png"), await readFile(frames[0]!.path))
  await encodeCompositorRecording(root, frames, options.quality.fps)
  await rm(directory, { recursive: true, force: true })
  return result as Result
}

async function nextBrowserFrame(page: Page, threshold: number): Promise<number> {
  return page.evaluate(target => new Promise<number>(resolve => {
    const sample = (timestamp: number) => timestamp >= target ? resolve(timestamp) : requestAnimationFrame(sample)
    requestAnimationFrame(sample)
  }), threshold)
}

async function encodeCompositorRecording(root: string, frames: readonly { path: string; timestamp: number }[], fps: number): Promise<void> {
  if (frames.length < 2) throw new Error("Compositor recording needs at least two frames.")
  const manifest = join(root, "compositor.ffconcat")
  const fallbackDuration = 1 / fps
  const lines = ["ffconcat version 1.0"]
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!
    const next = frames[index + 1]
    const duration = next ? Math.max((next.timestamp - frame.timestamp) / 1000, fallbackDuration) : fallbackDuration
    lines.push(`file '${escapeConcatPath(frame.path)}'`, `duration ${duration.toFixed(6)}`)
  }
  lines.push(`file '${escapeConcatPath(frames.at(-1)!.path)}'`)
  await writeFile(manifest, `${lines.join("\n")}\n`)
  try {
    await runProcess(process.env.PR_EVIDENCE_FFMPEG ?? "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", manifest,
      "-an", "-c:v", "libvpx-vp9", "-crf", "18", "-b:v", "0", "-pix_fmt", "yuv420p", "-fps_mode", "vfr", join(root, "raw.webm"),
    ])
  } finally {
    await rm(manifest, { force: true })
  }
}

function escapeConcatPath(path: string): string {
  return path.replaceAll("\\", "/").replaceAll("'", "'\\''")
}

async function runProcess(command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", chunk => {
      stderr = `${stderr}${chunk}`.slice(-8_192)
    })
    child.once("error", reject)
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`FFmpeg exited with ${code ?? "unknown"}: ${stderr.trim()}`)))
  })
}

async function captureCompositorScreenshot(page: Page, options: ResolvedScreenshotOptions, existingSession?: CDPSession): Promise<Buffer> {
  const viewport = options.crop?.viewport ?? page.viewportSize() ?? await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const crop = options.crop ?? fullViewportCrop(viewport)
  const session = existingSession ?? await page.context().newCDPSession(page)
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
    if (!existingSession) await session.detach()
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
