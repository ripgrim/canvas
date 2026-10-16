import { resolve } from "node:path"
import { createPlaywrightAutomation } from "../../../packages/editor-automation/dist/playwright.js"
import { geometryTarget } from "../../../packages/editor-automation/dist/index.js"
import { expect, test } from "@playwright/test"
import { evidencePort } from "../evidence-capture.js"
import { prEvidenceDefaultPorts, prEvidenceUrl } from "../ports.js"

const editorUrl = prEvidenceUrl("PR_EVIDENCE_EDITOR_PORT", prEvidenceDefaultPorts.editor)
const evidenceRoot = resolve(import.meta.dirname, "../../../outputs/pr-evidence/local/editor.clipboard-drop/browser")

test("PR-EVIDENCE-016 [editor.clipboard-drop]", async ({ page }) => {
  const automation = createPlaywrightAutomation({ page, evidence: evidencePort(evidenceRoot, []) })
  await page.goto(editorUrl, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: /New file/i }).first().click()
  const stage = page.locator(".canvas-stage")
  await stage.waitFor()
  await page.frameLocator('iframe[title="Canvas"]').locator("#preview-root").waitFor({ state: "attached" })
  await expect(stage).not.toHaveAttribute("data-inactive", "true")
  const bounds = await stage.boundingBox()
  if (!bounds) throw new Error("Canvas stage has no bounds.")
  const pointer = geometryTarget(async () => ({ x: bounds.x + bounds.width / 2 + 120, y: bounds.y + bounds.height / 2 + 70 }))
  const outside = geometryTarget(async () => ({ x: 24, y: 24 }))

  expect(await automation.clipboard.dropText("Dropped at pointer", outside)).toBe(false)
  expect(await automation.clipboard.dropText("Dropped at pointer", pointer)).toBe(true)
  await expect.poll(async () => (await automation.layers.selected()).length).toBe(1)
  const text = (await automation.layers.selected())[0]!
  await text.expectKind("text")
  const node = await text.resolve()
  const expected = await pointer.resolve()
  expect(node.bounds.x).toBeCloseTo(expected.x, 0)
  expect(node.bounds.y).toBeCloseTo(expected.y, 0)
  await expect(page.frameLocator('iframe[title="Canvas"]').locator(`[data-preview-canvas="${text.id}"]`)).toContainText("Dropped at pointer")
  await automation.evidence.screenshot("dropped")
})
