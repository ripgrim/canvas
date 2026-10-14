import { resolve } from "node:path"
import { createPlaywrightAutomation } from "../../../packages/editor-automation/dist/playwright.js"
import { expect, test } from "@playwright/test"
import { evidencePort } from "../evidence-capture.js"

const evidenceRoot = resolve(import.meta.dirname, "../../../outputs/pr-evidence/local/application.login/browser")

test("PR-EVIDENCE-012 [application.login]", async ({ page }) => {
  const automation = createPlaywrightAutomation({ page, evidence: evidencePort(evidenceRoot, []) })
  await page.goto("http://127.0.0.1:4329/", { waitUntil: "domcontentloaded" })

  await expect(page.getByRole("img", { name: "Comp AI" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Canvas" })).toBeVisible()
  const email = page.getByRole("button", { name: "Continue", exact: true })
  const google = page.getByRole("button", { name: "Continue with Google" })
  const github = page.getByRole("button", { name: "Continue with GitHub" })
  await expect(email).toBeDisabled()
  await expect(google).toBeDisabled()
  await expect(github).toBeEnabled()
  await expect(google).toHaveCSS("height", await github.evaluate(element => getComputedStyle(element).height))
  await automation.evidence.screenshot("ready")
})
