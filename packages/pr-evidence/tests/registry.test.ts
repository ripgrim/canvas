import { describe, expect, it } from "vitest"
import { canonicalJson, defineCapability, defineEvidenceScenario, parseGitNameStatus, planEvidence, selectEvidenceBase } from "../src/registry.js"

const capabilities = [
  defineCapability({ id: "editor.canvas.move", paths: ["packages/editor/src/features/editor/canvas-*.ts"], evidence: "visual" }),
  defineCapability({ id: "docs.research", paths: ["docs/research/**"], evidence: "nonvisual", reason: "Research does not change runtime behavior." }),
]

const scenarios = [
  defineEvidenceScenario({ id: "editor.transient-move", title: "Transient move", capabilities: ["editor.canvas.move"], adapters: ["browser"], assertions: ["hud.follows"], screenshots: ["held", "placed"], video: true }),
]

describe("evidence planning", () => {
  it("produces stable plans independent of input order", () => {
    const left = planEvidence({ changed: [{ path: "docs/research/a.md" }, { path: "packages/editor/src/features/editor/canvas-gestures.ts" }], capabilities, scenarios })
    const right = planEvidence({ changed: [{ path: "packages/editor/src/features/editor/canvas-gestures.ts" }, { path: "docs/research/a.md" }], capabilities: [...capabilities].reverse(), scenarios })
    expect(canonicalJson(left)).toBe(canonicalJson(right))
    expect(left.scenarios.map(value => value.id)).toEqual(["editor.transient-move"])
  })

  it("binds the plan to its adoption boundary", () => {
    const left = planEvidence({ changed: [], adoptionSha: "a".repeat(40), capabilities, scenarios })
    const right = planEvidence({ changed: [], adoptionSha: "b".repeat(40), capabilities, scenarios })
    expect(left.registryDigest).not.toBe(right.registryDigest)
  })

  it("PR-EVIDENCE-009 isolates changes after adoption", () => {
    const base = "a".repeat(40)
    const adoptionSha = "b".repeat(40)
    const head = "c".repeat(40)
    const ancestry = new Set([`${adoptionSha}:${head}`])
    expect(selectEvidenceBase({ base, head, adoptionSha, isAncestor: (left, right) => ancestry.has(`${left}:${right}`) })).toBe(adoptionSha)
    ancestry.add(`${adoptionSha}:${base}`)
    expect(selectEvidenceBase({ base, head, adoptionSha, isAncestor: (left, right) => ancestry.has(`${left}:${right}`) })).toBe(base)
    expect(() => selectEvidenceBase({ base, head, adoptionSha, isAncestor: () => false })).toThrow("not in")
  })

  it("plans nonvisual changes without scenarios", () => {
    const plan = planEvidence({ changed: [{ path: "docs/research/a.md" }], capabilities, scenarios })
    expect(plan.scenarios).toEqual([])
    expect(plan.files[0]?.reason).toBe("Research does not change runtime behavior.")
  })

  it("fails closed for unmapped and uncovered visual paths", () => {
    expect(() => planEvidence({ changed: [{ path: "unknown.ts" }], capabilities, scenarios })).toThrow("Unmapped")
    expect(() => planEvidence({ changed: [{ path: "packages/editor/src/features/editor/canvas-gestures.ts" }], capabilities, scenarios: [] })).toThrow("no scenario")
  })

  it("includes both sides of a rename", () => {
    const plan = planEvidence({ changed: [{ path: "docs/research/new.md", previousPath: "docs/research/old.md" }], capabilities, scenarios })
    expect(plan.files.map(value => value.path)).toEqual(["docs/research/new.md", "docs/research/old.md"])
  })

  it("parses null-delimited git changes without losing renames", () => {
    expect(parseGitNameStatus("M\0a.ts\0R100\0old.ts\0new.ts\0")).toEqual([
      { path: "a.ts" },
      { path: "new.ts", previousPath: "old.ts" },
    ])
    expect(() => parseGitNameStatus("R100\0old.ts\0")).toThrow("rename")
  })
})
