import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createPlaywrightAutomation } from "../../../packages/editor-automation/dist/playwright.js"
import { geometryTarget } from "../../../packages/editor-automation/dist/index.js"
import { expect, test } from "@playwright/test"
import { evidencePort, writeCaptureReport } from "../evidence-capture.js"

const editorUrl = "http://127.0.0.1:4327/"
const evidenceRoot = resolve(import.meta.dirname, "../../../outputs/pr-evidence/local/editor.text-overlay/browser")

test("PAPER-TEXT-004 [editor.text-overlay]", async ({ page }) => {
  const frameTimes: number[] = []
  const automation = createPlaywrightAutomation({ page, evidence: evidencePort(evidenceRoot, frameTimes) })

  await page.goto(editorUrl, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: /New file/i }).first().click()
  await page.locator(".canvas-stage").waitFor()
  await page.frameLocator('iframe[title="Canvas"]').locator("#preview-root").waitFor({ state: "attached" })

  const stage = await requiredBox(page.locator(".canvas-stage").boundingBox(), "canvas stage")
  const center = geometryTarget(async () => ({ x: stage.x + stage.width / 2, y: stage.y + stage.height / 2 }))
  await automation.keyboard.press("f")
  await automation.mouse.drag(center.offset(-180, -120), center.offset(180, 120), { steps: 10 })
  const frame = await automation.layers.named("Frame")
  await frame.expectKind("frame")

  await automation.keyboard.press("t")
  await automation.mouse.click(frame.center())
  await automation.keyboard.type("Overlay stays here")
  await automation.keyboard.press("Escape")
  const selected = await automation.layers.selected()
  expect(selected).toHaveLength(1)
  const text = await selected[0]!.expectKind("text")

  const alignment = page.getByRole("radiogroup", { name: "Horizontal alignment" })
  await alignment.getByRole("radio", { name: "Center" }).click()
  await automation.keyboard.press("v")
  await expect.poll(async () => {
    try {
      const value = await text.overlay()
      return { resize: value.resizeHandles.length, rotation: value.rotationHandles.length }
    } catch {
      return null
    }
  }).toEqual({ resize: 8, rotation: 4 })
  const overlay = await text.overlay()
  const snapshot = await text.resolve()
  expect(overlay.bounds.x).toBeCloseTo(snapshot.bounds.x, 1)
  expect(overlay.bounds.y).toBeCloseTo(snapshot.bounds.y, 1)
  expect(overlay.bounds.width).toBeCloseTo(snapshot.bounds.width, 1)
  expect(overlay.bounds.height).toBeCloseTo(snapshot.bounds.height, 1)
  expect(overlay.resizeHandles).toEqual(["top-left", "top", "top-right", "right", "bottom-right", "bottom", "bottom-left", "left"])
  expect(overlay.rotationHandles).toEqual(["top-left", "top-right", "bottom-right", "bottom-left"])
  await automation.evidence.screenshot("overlay", { crop: { kind: "node", node: text, padding: 32 }, scale: 2 })
  const expectedWidth = (Math.ceil(snapshot.bounds.x + snapshot.bounds.width + 32) - Math.floor(snapshot.bounds.x - 32)) * 2
  const expectedHeight = (Math.ceil(snapshot.bounds.y + snapshot.bounds.height + 32) - Math.floor(snapshot.bounds.y - 32)) * 2
  expect(pngDimensions(await readFile(join(evidenceRoot, "overlay.png")))).toEqual({ width: expectedWidth, height: expectedHeight })

  await automation.evidence.record({ crop: { kind: "node", node: text, padding: 32 } }, async () => {
    await automation.mouse.drag(text.center(), text.center().offset(18, 0), { steps: 8 })
    await automation.mouse.drag(text.center(), text.center().offset(-18, 0), { steps: 8 })
  })

  expect(frameTimes.length).toBeGreaterThan(0)
  expect(pngDimensions(await readFile(join(evidenceRoot, "poster.png")))).toEqual({ width: expectedWidth, height: expectedHeight })
  await writeCaptureReport(evidenceRoot, frameTimes)
  await automation.mouse.click(center.offset(0, -200))
  await expect(text.overlay()).rejects.toMatchObject({ code: "stale-projection" })
})

async function requiredBox(input: Promise<{ x: number; y: number; width: number; height: number } | null>, label: string) {
  const box = await input
  if (!box) throw new Error(`${label} has no bounds.`)
  return box
}

function pngDimensions(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}
