import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createPlaywrightAutomation } from "../../../packages/editor-automation/dist/playwright.js"
import { geometryTarget, type NodeRef } from "../../../packages/editor-automation/dist/index.js"
import { expect, test, type Page } from "@playwright/test"
import { evidencePort, writeCaptureReport } from "../evidence-capture.js"
import { prEvidenceDefaultPorts, prEvidenceUrl } from "../ports.js"

const editorUrl = prEvidenceUrl("PR_EVIDENCE_EDITOR_PORT", prEvidenceDefaultPorts.editor)
const evidenceRoot = resolve(import.meta.dirname, "../../../outputs/pr-evidence/local/editor.node-overlay/browser")

test("PR-EVIDENCE-011 [editor.node-overlay]", async ({ page }) => {
  const frameTimes: number[] = []
  const automation = createPlaywrightAutomation({ page, evidence: evidencePort(evidenceRoot, frameTimes) })

  await page.goto(editorUrl, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: /New file/i }).first().click()
  await page.locator(".canvas-stage").waitFor()
  await page.frameLocator('iframe[title="Canvas"]').locator("#preview-root").waitFor({ state: "attached" })

  const stage = await requiredBox(page.locator(".canvas-stage").boundingBox(), "canvas stage")
  const center = geometryTarget(async () => ({ x: stage.x + stage.width / 2, y: stage.y + stage.height / 2 }))
  await automation.keyboard.press("f")
  await automation.mouse.drag(center.offset(-110, -60), center.offset(110, 60), { steps: 10 })
  const frame = await automation.layers.named("Frame")
  await frame.expectKind("frame")

  await expect.poll(async () => {
    try {
      const value = await frame.overlay()
      return { resize: value.resizeHandles.length, rotation: value.rotationHandles.length }
    } catch {
      return null
    }
  }).toEqual({ resize: 8, rotation: 4 })
  const overlay = await frame.overlay()
  const snapshot = await frame.resolve()
  expect(overlay.bounds.x).toBeCloseTo(snapshot.bounds.x, 1)
  expect(overlay.bounds.y).toBeCloseTo(snapshot.bounds.y, 1)
  expect(overlay.bounds.width).toBeCloseTo(snapshot.bounds.width, 1)
  expect(overlay.bounds.height).toBeCloseTo(snapshot.bounds.height, 1)
  expect(overlay.resizeHandles).toEqual(["top-left", "top", "top-right", "right", "bottom-right", "bottom", "bottom-left", "left"])
  expect(overlay.rotationHandles).toEqual(["top-left", "top-right", "bottom-right", "bottom-left"])
  await automation.evidence.screenshot("overlay", { crop: { kind: "node", node: frame, padding: 32 }, scale: 2 })
  const expectedWidth = (Math.ceil(snapshot.bounds.x + snapshot.bounds.width + 32) - Math.floor(snapshot.bounds.x - 32)) * 2
  const expectedHeight = (Math.ceil(snapshot.bounds.y + snapshot.bounds.height + 32) - Math.floor(snapshot.bounds.y - 32)) * 2
  expect(pngDimensions(await readFile(join(evidenceRoot, "overlay.png")))).toEqual({ width: expectedWidth, height: expectedHeight })

  const preview = page.locator('iframe[title="Canvas"]')
  await invokePreviewLifecycle(preview, "onError")
  await expect(page.locator(".canvas-stage")).toHaveAttribute("data-inactive", "true")
  await expect(page.getByRole("status")).toContainText("Connecting")
  await expectOverlayMatches(page, frame, 4)
  await nextBrowserPaint(page)
  expect(await paintedHudPixels(page)).toBeGreaterThan(0)
  await automation.evidence.screenshot("overlay-reconnecting", { crop: { kind: "node", node: frame, padding: 32 }, scale: 2 })
  await invokePreviewLifecycle(preview, "onLoad")
  await expect.poll(async () => page.getByRole("status").count()).toBe(0)
  await expect(page.locator(".canvas-stage")).not.toHaveAttribute("data-inactive", "true")
  await expectOverlayMatches(page, frame, 4)

  await automation.evidence.record({
    crop: { kind: "node", node: frame, padding: 32 },
    quality: { mode: "compositor" },
  }, async () => {
    await automation.mouse.drag(frame.center(), frame.center().offset(18, 0), { steps: 8 })
    await automation.mouse.drag(frame.center(), frame.center().offset(-18, 0), { steps: 8 })
  })

  expect(frameTimes.length).toBeGreaterThan(0)
  expect(pngDimensions(await readFile(join(evidenceRoot, "poster.png")))).toEqual({ width: expectedWidth, height: expectedHeight })
  await writeCaptureReport(evidenceRoot, frameTimes)
  await automation.mouse.click(center.offset(0, -200))
  await expect(frame.overlay()).rejects.toMatchObject({ code: "stale-projection" })
  await automation.mouse.click(frame.center())
  await expect.poll(async () => {
    try {
      const value = await frame.overlay()
      return { resize: value.resizeHandles.length, rotation: value.rotationHandles.length }
    } catch {
      return null
    }
  }).toEqual({ resize: 8, rotation: 4 })

  await page.getByRole("button", { name: "Switch editor appearance to dark", exact: true }).click()
  await expect(page.locator(".editor-root")).toHaveClass(/theme-dark/u)
  await expectOverlayMatches(page, frame, 4)
  await automation.evidence.screenshot("overlay-dark", { crop: { kind: "node", node: frame, padding: 32 }, scale: 2 })

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator(".work-area")).toHaveAttribute("data-mobile", "true")
  await expectOverlayMatches(page, frame, 0)
  await automation.evidence.screenshot("overlay-mobile")
})

async function expectOverlayMatches(page: Page, frame: NodeRef<"frame">, rotationHandles: number) {
  await expect.poll(async () => {
    try {
      const overlay = await frame.overlay()
      const node = await page.frameLocator('iframe[title="Canvas"]').locator(`[data-preview-instance="${frame.id}"], [data-preview-canvas="${frame.id}"]`).boundingBox()
      if (!node) return null
      return {
        x: Math.round(overlay.bounds.x - node.x),
        y: Math.round(overlay.bounds.y - node.y),
        width: Math.round(overlay.bounds.width - node.width),
        height: Math.round(overlay.bounds.height - node.height),
        resize: overlay.resizeHandles.length,
        rotation: overlay.rotationHandles.length,
      }
    } catch {
      return null
    }
  }).toEqual({ x: 0, y: 0, width: 0, height: 0, resize: 8, rotation: rotationHandles })
}

async function requiredBox(input: Promise<{ x: number; y: number; width: number; height: number } | null>, label: string) {
  const box = await input
  if (!box) throw new Error(`${label} has no bounds.`)
  return box
}

function pngDimensions(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

async function invokePreviewLifecycle(preview: ReturnType<Page["locator"]>, handler: "onError" | "onLoad") {
  await preview.evaluate((element, name) => {
    const key = Reflect.ownKeys(element).find(value => typeof value === "string" && value.startsWith("__reactProps$"))
    if (!key) throw new Error("Mounted preview props are unavailable.")
    const props = Reflect.get(element, key) as Record<string, unknown>
    const callback = props[name]
    if (typeof callback !== "function") throw new Error(`Mounted preview ${name} callback is unavailable.`)
    callback({ currentTarget: element })
  }, handler)
}

async function nextBrowserPaint(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function paintedHudPixels(page: Page) {
  return page.locator(".canvas-hud-canvas").evaluate(element => {
    const canvas = element as HTMLCanvasElement
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Canvas HUD context is unavailable.")
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let painted = 0
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] !== 0) painted += 1
    return painted
  })
}
