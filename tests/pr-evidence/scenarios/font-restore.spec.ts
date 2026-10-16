import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createPlaywrightAutomation } from "../../../packages/editor-automation/dist/playwright.js"
import { geometryTarget } from "../../../packages/editor-automation/dist/index.js"
import { expect, test } from "@playwright/test"
import { evidencePort, writeCaptureReport } from "../evidence-capture.js"
import { prEvidenceDefaultPorts, prEvidenceUrl } from "../ports.js"

const editorUrl = prEvidenceUrl("PR_EVIDENCE_EDITOR_PORT", prEvidenceDefaultPorts.editor)
const evidenceRoot = resolve(import.meta.dirname, "../../../outputs/pr-evidence/local/editor.font-restore/browser")
const fixtureFont = resolve(import.meta.dirname, "../../../fixtures/stateful-shadcn-repo/src/assets/stateful-fixture.woff2")

test("PR-EVIDENCE-018 [editor.font-restore]", async ({ page }) => {
  const frameTimes: number[] = []
  const automation = createPlaywrightAutomation({ page, evidence: evidencePort(evidenceRoot, frameTimes) })
  const fontBytes = await readFile(fixtureFont)
  let fontRequests = 0
  await page.route("https://fonts.googleapis.com/**", route => route.fulfill({
    contentType: "text/css",
    body: "@font-face { font-family: 'Geist'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/geist/test/geist.woff2) format('woff2'); }",
  }))
  await page.route("https://fonts.gstatic.com/**", route => {
    fontRequests += 1
    return route.fulfill({ contentType: "font/woff2", body: fontBytes, headers: { "access-control-allow-origin": "*" } })
  })

  await page.goto(editorUrl, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: /New file/i }).first().click()
  const stage = page.locator(".canvas-stage")
  await stage.waitFor()
  const preview = page.frameLocator('iframe[title="Canvas"]')
  await preview.locator("#preview-root").waitFor({ state: "attached" })
  await expect(stage).not.toHaveAttribute("data-inactive", "true")
  const bounds = await stage.boundingBox()
  if (!bounds) throw new Error("Canvas stage has no bounds.")
  const center = geometryTarget(async () => ({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }))

  await automation.keyboard.press("t")
  await automation.mouse.drag(center.offset(-110, -20), center.offset(110, 20), { steps: 8 })
  await page.locator(".canvas-text-editor").waitFor()
  await automation.keyboard.type("Geist survives reload")
  await automation.keyboard.press("Escape")
  const selected = (await automation.layers.selected())[0]
  if (!selected) throw new Error("Expected the created text layer to remain selected.")

  await automation.evidence.record(async () => {
    await page.getByRole("button", { name: "Font family", exact: true }).click()
    const picker = page.getByRole("dialog", { name: "Font family", exact: true })
    await picker.getByRole("textbox", { name: "Search fonts", exact: true }).fill("Geist")
    await picker.getByRole("button", { name: "Geist", exact: true }).click()
    await expect(page.getByRole("button", { name: "Font family", exact: true })).toContainText("Geist")
    await expect.poll(() => fontRequests).toBeGreaterThan(0)
    const previewText = preview.locator(`[data-preview-canvas="${selected.id}"]`)
    await expect(previewText).toHaveCSS("font-family", "Geist")
    await expect.poll(() => previewText.evaluate(element => [...element.ownerDocument.fonts].some(face => face.family.replace(/["']/gu, "") === "Geist" && face.status === "loaded"))).toBe(true)
    await automation.evidence.screenshot("selected")

    const fileUrl = page.url()
    await page.reload({ waitUntil: "domcontentloaded" })
    expect(page.url()).toBe(fileUrl)
    await page.locator(".canvas-stage").waitFor()
    await preview.locator("#preview-root").waitFor({ state: "attached" })
    await expect(preview.locator(`[data-preview-canvas="${selected.id}"]`)).toHaveCSS("font-family", "Geist")
    await expect.poll(() => preview.locator(`[data-preview-canvas="${selected.id}"]`).evaluate(element => [...element.ownerDocument.fonts].some(face => face.family.replace(/["']/gu, "") === "Geist" && face.status === "loaded"))).toBe(true)
    await expect(page.getByRole("dialog", { name: "Font family", exact: true })).toHaveCount(0)
    await automation.evidence.screenshot("restored")
  })

  expect(fontRequests).toBeGreaterThanOrEqual(2)
  await writeCaptureReport(evidenceRoot, frameTimes)
})
