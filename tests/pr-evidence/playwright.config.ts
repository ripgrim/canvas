import { defineConfig } from "@playwright/test"
import { prEvidenceDefaultPorts, readPrEvidencePort } from "./ports"

const selected = process.env.PR_EVIDENCE_SCENARIOS ? JSON.parse(process.env.PR_EVIDENCE_SCENARIOS) as unknown : null
if (selected !== null && (!Array.isArray(selected) || selected.some(value => typeof value !== "string"))) throw new Error("Invalid PR evidence scenario selection.")
const grep = selected && selected.length
  ? new RegExp(`\\[(${selected.map(value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")})\\]`, "u")
  : undefined
const headed = process.env.PR_EVIDENCE_HEADED === "1"
const slowMo = process.env.PR_EVIDENCE_SLOW_MO ? Number(process.env.PR_EVIDENCE_SLOW_MO) : 0
if (!Number.isSafeInteger(slowMo) || slowMo < 0 || slowMo > 500) throw new Error("Invalid PR evidence slow motion value.")

const editorPort = readPrEvidencePort("PR_EVIDENCE_EDITOR_PORT", prEvidenceDefaultPorts.editor)
const previewPort = readPrEvidencePort("PR_EVIDENCE_PREVIEW_PORT", prEvidenceDefaultPorts.preview)
const loginPort = readPrEvidencePort("PR_EVIDENCE_LOGIN_PORT", prEvidenceDefaultPorts.login)
const editorUrl = `http://127.0.0.1:${editorPort}`
const previewUrl = `http://127.0.0.1:${previewPort}`

export default defineConfig({
  testDir: "./scenarios",
  outputDir: "../../outputs/pr-evidence/playwright",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  ...(grep ? { grep } : {}),
  use: {
    browserName: "chromium",
    headless: !headed,
    launchOptions: { slowMo },
    viewport: { width: 1500, height: 940 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `node scripts/with-local-registry.mjs --filter @canvas/web exec vite --config vite.preview.config.ts --host 127.0.0.1 --port ${previewPort} --strictPort`,
      cwd: "../..",
      env: { CANVAS_PREVIEW_CACHE_DIR: "../../../.cache/pr-evidence/vite-preview", CANVAS_PREVIEW_EDITOR_ORIGIN: editorUrl },
      url: `${previewUrl}/`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm --filter @canvas/web exec vite --host 127.0.0.1 --port ${editorPort} --strictPort`,
      cwd: "../..",
      env: { VITE_API_ORIGIN: "", VITE_LOGIN_ORIGIN: "", VITE_PREVIEW_ORIGIN: previewUrl, VITE_BROWSER_TEST_STORAGE: "1" },
      url: `${editorUrl}/`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm --filter @canvas/login exec vite --host 127.0.0.1 --port ${loginPort} --strictPort`,
      cwd: "../..",
      env: { VITE_API_URL: "http://127.0.0.1:4320", VITE_APP_URL: `${editorUrl}/` },
      url: `http://127.0.0.1:${loginPort}/`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
