import { resolve } from "node:path"
import { createPlaywrightAutomation } from "../../../packages/editor-automation/dist/playwright.js"
import { geometryTarget } from "../../../packages/editor-automation/dist/index.js"
import { expect, test } from "@playwright/test"
import { evidencePort, writeCaptureReport } from "../evidence-capture.js"

const editorUrl = "http://127.0.0.1:4327/"
const evidenceRoot = resolve(import.meta.dirname, "../../../outputs/pr-evidence/local/editor.typography/browser")

test("PR-EVIDENCE-013 [editor.typography]", async ({ page }) => {
  const frameTimes: number[] = []
  const automation = createPlaywrightAutomation({ page, evidence: evidencePort(evidenceRoot, frameTimes) })
  await page.goto(editorUrl, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: /New file/i }).first().click()
  const stage = page.locator(".canvas-stage")
  await stage.waitFor()
  await page.frameLocator('iframe[title="Canvas"]').locator("#preview-root").waitFor({ state: "attached" })
  await expect(stage).not.toHaveAttribute("data-inactive", "true")
  const bounds = await stage.boundingBox()
  if (!bounds) throw new Error("Canvas stage has no bounds.")
  const point = geometryTarget(async () => ({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }))

  await automation.keyboard.press("t")
  await automation.mouse.drag(point.offset(-100, -20), point.offset(100, 20), { steps: 8 })
  await page.locator(".canvas-text-editor").waitFor()
  await automation.keyboard.type("Typography evidence")
  await automation.keyboard.press("Escape")
  await expect(page.getByRole("heading", { name: "Text" })).toBeVisible()

  await automation.evidence.record(async () => {
    await page.getByRole("button", { name: "Font family" }).click()
    await expect(page.getByRole("dialog", { name: "Font family" })).toBeVisible()
    await expect(page.getByRole("textbox", { name: "Search fonts" })).toBeFocused()
    await expect(page.getByRole("listbox", { name: "Fonts" })).toBeVisible()
    await automation.evidence.screenshot("font-picker")
  })
  await writeCaptureReport(evidenceRoot, frameTimes)
})
