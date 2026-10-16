import { describe, expect, it } from "vitest"
import { localOrigins } from "../../scripts/local-services.mjs"
import { prEvidenceDefaultPorts, readPrEvidencePort } from "./ports"

describe("PR-EVIDENCE-003 isolated browser ports", () => {
  it("does not overlap the full local stack", () => {
    const localPorts = new Set(Object.values(localOrigins).map(origin => Number(new URL(origin).port)))
    expect(Object.values(prEvidenceDefaultPorts).every(port => !localPorts.has(port))).toBe(true)
  })

  it("rejects invalid overrides", () => {
    const previous = process.env.PR_EVIDENCE_EDITOR_PORT
    process.env.PR_EVIDENCE_EDITOR_PORT = "4327.5"
    try { expect(() => readPrEvidencePort("PR_EVIDENCE_EDITOR_PORT", prEvidenceDefaultPorts.editor)).toThrow("Invalid PR_EVIDENCE_EDITOR_PORT.") }
    finally {
      if (previous === undefined) delete process.env.PR_EVIDENCE_EDITOR_PORT
      else process.env.PR_EVIDENCE_EDITOR_PORT = previous
    }
  })
})
