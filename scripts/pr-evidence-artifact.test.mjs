import assert from "node:assert/strict"
import { test } from "node:test"
import { selectEvidenceArtifact } from "./pr-evidence-artifact.mjs"

test("PR-EVIDENCE-SEC-002 selects one bounded exact artifact", () => {
  const selected = selectEvidenceArtifact({ artifacts: [{ id: 9, name: "pr-evidence-1-2", size_in_bytes: 1024, expired: false }] }, "pr-evidence-1-2")
  assert.deepEqual(selected, { id: 9, bytes: 1024 })
  assert.throws(() => selectEvidenceArtifact({ artifacts: [{ id: 9, name: "other", size_in_bytes: 1024, expired: false }] }, "pr-evidence-1-2"), /one exact/u)
  assert.throws(() => selectEvidenceArtifact({ artifacts: [{ id: 9, name: "pr-evidence-1-2", size_in_bytes: 41 * 1024 * 1024, expired: false }] }, "pr-evidence-1-2"), /size/u)
})
