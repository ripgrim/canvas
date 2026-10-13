import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

const capture = await readFile(new URL("../.github/workflows/pr-evidence.yml", import.meta.url), "utf8")
const publish = await readFile(new URL("../.github/workflows/pr-evidence-publish.yml", import.meta.url), "utf8")

test("PR-EVIDENCE-SEC-001 capture runs without write permissions or secrets", () => {
  assert.match(capture, /permissions:\s+contents: read/u)
  assert.doesNotMatch(capture, /pull-requests: write|secrets\.|environment:/u)
  assert.match(capture, /persist-credentials: false/u)
})

test("PR-EVIDENCE-006 capture plans before browser execution", () => {
  assert.ok(capture.indexOf("Plan evidence") < capture.indexOf("Capture browser evidence"))
  assert.match(capture, /if: steps\.plan\.outputs\.visual == 'true'/u)
  assert.match(capture, /if-no-files-found: error/u)
})

test("PR-EVIDENCE-SEC-002 publisher uses only trusted code and the exact upstream artifact", () => {
  assert.match(publish, /workflow_run:/u)
  assert.match(publish, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/u)
  assert.doesNotMatch(publish, /workflow_run\.head_sha|pull_requests\[0\]\.head/u)
  assert.match(publish, /node scripts\/pr-evidence-artifact\.mjs/u)
  assert.ok(publish.indexOf("Validate upstream artifact metadata") < publish.indexOf("Download exact evidence artifact"))
  assert.match(publish, /artifact-ids: \$\{\{ steps\.artifact\.outputs\.artifact-id \}\}/u)
  assert.match(publish, /pnpm install --frozen-lockfile --ignore-scripts/u)
})

test("PR-EVIDENCE-008 secrets exist only in the trusted publisher", () => {
  assert.doesNotMatch(capture, /CLOUDFLARE_API_TOKEN|GITHUB_TOKEN/u)
  assert.match(publish, /CLOUDFLARE_API_TOKEN/u)
  assert.match(publish, /pull-requests: write/u)
})
