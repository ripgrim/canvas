import { resolve } from "node:path"
import { createPlaywrightAutomation } from "../../../packages/editor-automation/dist/playwright.js"
import { expect, test } from "@playwright/test"
import { evidencePort, writeCaptureReport } from "../evidence-capture.js"
import { prEvidenceDefaultPorts, prEvidenceUrl } from "../ports.js"

const editorUrl = prEvidenceUrl("PR_EVIDENCE_EDITOR_PORT", prEvidenceDefaultPorts.editor)
const evidenceRoot = resolve(import.meta.dirname, "../../../outputs/pr-evidence/local/editor.theme-token-color/browser")

test("PR-EVIDENCE-015 [editor.theme-token-color]", async ({ page }) => {
  const frameTimes: number[] = []
  const automation = createPlaywrightAutomation({ page, evidence: evidencePort(evidenceRoot, frameTimes) })

  await page.goto(editorUrl, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: /New file/i }).first().click()
  await page.locator(".canvas-stage").waitFor()
  await page.frameLocator('iframe[title="Canvas"]').locator("#preview-root").waitFor({ state: "attached" })

  await automation.theme.createToken("Color")
  await expect(page.locator(".theme-editor")).toBeVisible()
  await automation.theme.renameToken("Brand accent")
  const previewTrigger = page.locator(".theme-editor .color-picker-trigger-preview")
  const opacity = page.getByRole("textbox", { name: "Brand accent opacity", exact: true })
  await expect(previewTrigger).toHaveAttribute("aria-label", "Edit Brand accent color")
  await expect(opacity).toHaveValue("100")
  expect(await opacity.evaluate(element => element.closest("button") === null)).toBe(true)

  await automation.evidence.record(async () => {
    await automation.theme.openColorPicker("Brand accent")
    const picker = page.locator(".color-picker-popup")
    await expect(picker).toBeVisible()
    expect(await picker.evaluate(element => element.closest(".theme-editor") !== null)).toBe(true)
    await automation.evidence.screenshot("picker-light")

    await automation.keyboard.press("Escape")
    await expect(picker).toBeHidden()
    await expect(previewTrigger).toBeFocused()

    await automation.theme.setColorOpacity("Brand accent", 42)
    await expect(opacity).toHaveValue("42")
    await expect(picker).toBeHidden()
    await automation.evidence.screenshot("opacity-42")

    await page.getByRole("button", { name: "Switch editor appearance to dark", exact: true }).click()
    await expect(page.locator(".editor-root")).toHaveClass(/theme-dark/u)
    await automation.theme.openToken("Brand accent")
    await automation.theme.openColorPicker("Brand accent")
    await expect(picker).toBeVisible()
    expect(await picker.evaluate(element => element.closest(".theme-dark") !== null)).toBe(true)
    await automation.evidence.screenshot("picker-dark")
    await page.getByRole("button", { name: "Close color picker", exact: true }).click()
  })

  await writeCaptureReport(evidenceRoot, frameTimes)
})
