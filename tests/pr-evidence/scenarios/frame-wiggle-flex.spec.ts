import { resolve } from "node:path"
import { createPlaywrightAutomation } from "../../../packages/editor-automation/dist/playwright.js"
import { geometryTarget } from "../../../packages/editor-automation/dist/index.js"
import { expect, test, type Page } from "@playwright/test"
import { evidencePort, writeCaptureReport } from "../evidence-capture.js"
import { prEvidenceDefaultPorts, prEvidenceUrl } from "../ports.js"

const editorUrl = prEvidenceUrl("PR_EVIDENCE_EDITOR_PORT", prEvidenceDefaultPorts.editor)
const evidenceRoot = resolve(import.meta.dirname, "../../../outputs/pr-evidence/local/editor.frame-wiggle-flex/browser")
const wiggle = [
  { x: 57, y: 23 },
  { x: 23, y: 57 },
  { x: -23, y: 57 },
  { x: -57, y: 23 },
  { x: -57, y: -23 },
  { x: -23, y: -57 },
  { x: 23, y: -57 },
  { x: 57, y: -23 },
] as const

test("PR-EVIDENCE-010 [editor.frame-wiggle-flex]", async ({ page }) => {
  const frameTimes: number[] = []
  const automation = createPlaywrightAutomation({
    page,
    evidence: evidencePort(evidenceRoot, frameTimes),
  })

  await page.goto(editorUrl, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: /New file/i }).first().click()
  await page.locator(".canvas-stage").waitFor()
  await page.frameLocator('iframe[title="Canvas"]').locator("#preview-root").waitFor({ state: "attached" })

  const stage = await requiredBox(page.locator(".canvas-stage").boundingBox(), "canvas stage")
  const viewport = await page.locator(".canvas-viewport").evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }))
  const camera = await readCamera(page)
  const screen = (x: number, y: number) => Object.freeze({
    x: stage.x + viewport.width / 2 + camera.x + x * camera.zoom,
    y: stage.y + viewport.height / 2 + camera.y + y * camera.zoom,
  })

  await automation.keyboard.press("f")
  await automation.mouse.drag(geometryTarget(async () => screen(-250, -250)), geometryTarget(async () => screen(250, 250)), { steps: 12 })

  const frame = await automation.layers.named("Frame")
  await frame.expectKind("frame")
  const created = await storedNode(page, frame.id)
  expect(created.styles.width).toBe(500)
  expect(created.styles.height).toBe(500)
  const createdBounds = await frame.resolve()
  expect(createdBounds.bounds.width).toBeCloseTo(500 * camera.zoom, 1)
  expect(createdBounds.bounds.height).toBeCloseTo(500 * camera.zoom, 1)
  await automation.evidence.screenshot("created")

  const addFlex = page.getByRole("button", { name: /^Add flex/u })
  await expect(addFlex).toBeVisible()
  await expect(addFlex).toBeEnabled()
  let capturedHeldControl = false

  await automation.evidence.record(async () => {
    for (const delta of wiggle) {
      const before = await frame.resolve()
      const beforeNode = await storedNode(page, frame.id)
      await automation.mouse.drag(frame.center(), frame.center().offset(delta.x, delta.y), {
        steps: 8,
        whileHeld: async () => {
          const preview = previewNode(page, frame.id)
          const held = await requiredBox(preview.boundingBox(), "held frame")
          expect(held.x).toBeCloseTo(before.bounds.x + delta.x, 1)
          expect(held.y).toBeCloseTo(before.bounds.y + delta.y, 1)
          const hud = await readHud(page)
          const selected = hud.selected[frame.id]
          expect(selected).toBeTruthy()
          const hudBox = await requiredBox(page.locator(".canvas-hud-canvas").boundingBox(), "canvas HUD")
          expect(hudBox.x + selected.x).toBeCloseTo(held.x, 1)
          expect(hudBox.y + selected.y).toBeCloseTo(held.y, 1)
          expect(selected.width).toBeCloseTo(held.width, 1)
          expect(selected.height).toBeCloseTo(held.height, 1)
          expect((await storedNode(page, frame.id)).styles).toEqual(beforeNode.styles)
          await expect(addFlex).toBeVisible()
          await expect(addFlex).toBeDisabled()
          if (!capturedHeldControl) {
            await automation.evidence.screenshot("held-flex-control")
            capturedHeldControl = true
          }
        },
      })
      await expect(addFlex).toBeVisible()
      await expect(addFlex).toBeEnabled()
    }

    await automation.evidence.screenshot("wiggled")

    const fill = page.getByLabel("Fill 1 color", { exact: true })
    await fill.waitFor()
    await automation.mouse.click(geometryTarget(async () => center(await requiredBox(fill.boundingBox(), "fill color"))))
    await automation.keyboard.chord(["Control", "A"])
    await automation.keyboard.type("#FF0000")
    await automation.keyboard.press("Enter")
    await expect.poll(async () => fill.inputValue()).toBe("#FF0000")
    await expect.poll(async () => (await storedNode(page, frame.id)).appearance.fills[0]?.color).toEqual({ kind: "literal", color: { kind: "hex", hex: "#ff0000" } })
    await expect.poll(() => previewNode(page, frame.id).evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgb(255, 0, 0)")
    await automation.evidence.screenshot("red")

    await expect(addFlex).toBeVisible()
    await expect(addFlex).toBeEnabled()
    await automation.keyboard.chord(["Shift", "A"])
    await expect.poll(async () => (await storedNode(page, frame.id)).layout?.container?.display).toBe("flex")
    await expect.poll(() => previewNode(page, frame.id).evaluate(element => getComputedStyle(element).display)).toBe("flex")
    await automation.evidence.screenshot("flex")
  })

  const final = await storedNode(page, frame.id)
  expect(final.styles.width).toBe(500)
  expect(final.styles.height).toBe(500)
  expect(final.appearance.fills[0]?.color).toEqual({ kind: "literal", color: { kind: "hex", hex: "#ff0000" } })
  expect(final.layout?.container?.display).toBe("flex")
  expect(frameTimes.length).toBeGreaterThan(0)
  expect(frameTimes.every((value, index) => index === 0 || value >= frameTimes[index - 1]!)).toBe(true)
  await writeCaptureReport(evidenceRoot, frameTimes)
})

function previewNode(page: Page, id: string) {
  return page.frameLocator('iframe[title="Canvas"]').locator(`[data-preview-canvas="${id}"]`)
}

function center(bounds: { x: number; y: number; width: number; height: number }) {
  return Object.freeze({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })
}

async function requiredBox(input: Promise<{ x: number; y: number; width: number; height: number } | null>, label: string) {
  const box = await input
  if (!box) throw new Error(`${label} has no bounds.`)
  return box
}

async function readCamera(page: Page) {
  return page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(".canvas-world")
    const match = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/u.exec(element?.style.transform ?? "")
    if (!match) throw new Error("Canvas camera is unavailable.")
    return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) }
  })
}

async function readHud(page: Page): Promise<{ selected: Record<string, { x: number; y: number; width: number; height: number }> }> {
  return page.locator(".canvas-hud-canvas").evaluate(canvas => JSON.parse((canvas as HTMLElement).dataset.hud ?? '{"selected":{}}'))
}

async function storedNode(page: Page, id: string): Promise<{
  styles: { width: number; height: number; [key: string]: unknown }
  appearance: { fills: Array<{ color?: unknown }> }
  layout?: { container?: { display?: string } }
}> {
  const fileId = decodeURIComponent(new URL(page.url()).pathname.split("/").pop() ?? "")
  return page.evaluate(({ fileId: selectedFile, nodeId }) => {
    const raw = localStorage.getItem(`design-editor.browser-file.${selectedFile}.v3`)
    if (!raw) throw new Error("Stored file is unavailable.")
    const file = JSON.parse(raw).file as { nodes: Record<string, unknown> }
    const node = file.nodes[nodeId]
    if (!node) throw new Error(`Stored node ${nodeId} is unavailable.`)
    return node
  }, { fileId, nodeId: id })
}
