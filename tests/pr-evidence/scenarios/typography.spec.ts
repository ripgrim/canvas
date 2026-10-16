import { resolve } from "node:path"
import { createPlaywrightAutomation } from "../../../packages/editor-automation/dist/playwright.js"
import { geometryTarget } from "../../../packages/editor-automation/dist/index.js"
import { expect, test } from "@playwright/test"
import { evidencePort, writeCaptureReport } from "../evidence-capture.js"
import { prEvidenceDefaultPorts, prEvidenceUrl } from "../ports.js"

const editorUrl = prEvidenceUrl("PR_EVIDENCE_EDITOR_PORT", prEvidenceDefaultPorts.editor)
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

  await automation.keyboard.press("Escape")
  await page.getByRole("radio", { name: "Rectangle", exact: true }).click()
  await automation.mouse.drag(point.offset(-220, 80), point.offset(-40, 180), { steps: 8 })
  await page.getByRole("radio", { name: "Move", exact: true }).click()
  await page.getByRole("button", { name: "Add border", exact: true }).click()
  await page.getByRole("button", { name: "Add border", exact: true }).click()
  for (const side of ["Top", "Bottom"]) {
    const control = page.getByRole("combobox", { name: `${side} border side`, exact: true })
    await expect(control).toHaveText(side)
    const value = control.locator(".appearance-select-value")
    expect(await value.evaluate(element => {
      const text = element.firstChild
      if (!text) return false
      const range = document.createRange()
      range.selectNodeContents(text)
      return range.getBoundingClientRect().width <= element.getBoundingClientRect().width + 0.5
    })).toBe(true)
  }
  await automation.evidence.screenshot("border-controls")
  await writeCaptureReport(evidenceRoot, frameTimes)
})
