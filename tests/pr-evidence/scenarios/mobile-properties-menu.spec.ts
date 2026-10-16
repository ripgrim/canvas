import { resolve } from "node:path"
import { createPlaywrightAutomation } from "../../../packages/editor-automation/dist/playwright.js"
import { geometryTarget } from "../../../packages/editor-automation/dist/index.js"
import { expect, test } from "@playwright/test"
import { evidencePort, writeCaptureReport } from "../evidence-capture.js"
import { prEvidenceDefaultPorts, prEvidenceUrl } from "../ports.js"

const editorUrl = prEvidenceUrl("PR_EVIDENCE_EDITOR_PORT", prEvidenceDefaultPorts.editor)
const evidenceRoot = resolve(import.meta.dirname, "../../../outputs/pr-evidence/local/editor.mobile-properties-menu/browser")

test("PR-EVIDENCE-017 [editor.mobile-properties-menu]", async ({ page }) => {
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
  const center = geometryTarget(async () => ({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }))

  await automation.keyboard.press("r")
  await automation.mouse.drag(center.offset(-100, -60), center.offset(100, 60), { steps: 8 })
  await page.getByRole("radio", { name: "Move", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Rectangle", exact: true })).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole("button", { name: "Show properties", exact: true })).toBeVisible()

  await automation.evidence.record(async () => {
    await automation.panels.openMobile("Properties")
    const sheet = page.getByRole("dialog", { name: "Properties", exact: true })
    await expect(sheet).toBeVisible()
    await sheet.getByRole("button", { name: "Add border", exact: true }).click()

    const side = sheet.getByRole("combobox", { name: "Top border side", exact: true })
    await side.click()
    const listbox = sheet.getByRole("listbox")
    await expect(listbox).toBeVisible()
    expect(await listbox.evaluate(element => element.closest(".mobile-sheet-popup") !== null)).toBe(true)
    await automation.evidence.screenshot("menu-open")

    await automation.keyboard.press("Escape")
    await expect(listbox).toBeHidden()
    await expect(side).toBeFocused()
    await expect(sheet).toBeVisible()

    await side.click()
    await sheet.getByRole("option", { name: "Bottom", exact: true }).click()
    const committed = sheet.getByRole("combobox", { name: "Bottom border side", exact: true })
    await expect(committed).toHaveText("Bottom")
    await expect(committed).toBeFocused()
    await automation.evidence.screenshot("menu-committed")

    await automation.panels.closeMobile("Properties")
    await expect(page.getByRole("button", { name: "Show properties", exact: true })).toBeVisible()
  })

  await writeCaptureReport(evidenceRoot, frameTimes)
})
