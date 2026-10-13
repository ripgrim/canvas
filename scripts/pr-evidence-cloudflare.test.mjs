import assert from "node:assert/strict"
import { test } from "node:test"
import { isMissingBucket } from "./pr-evidence-cloudflare.mjs"

test("PR-EVIDENCE-008 recognizes only the exact missing bucket response", () => {
  assert.equal(isMissingBucket("The specified bucket does not exist [code: 10006]"), true)
  assert.equal(isMissingBucket("authentication failed [code: 10006]"), false)
  assert.equal(isMissingBucket("The specified bucket does not exist [code: 99999]"), false)
})
