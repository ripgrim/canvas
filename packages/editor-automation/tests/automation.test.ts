import { describe, expect, it } from "vitest"
import { boundsTarget, defineScenario, geometryTarget, scenarioId, sourcePath } from "../src/index.js"

describe("editor automation contracts", () => {
  it("resolves geometry lazily", async () => {
    let value = 10
    const target = geometryTarget(async () => ({ x: value, y: value })).offset(4, -2)
    value = 20
    await expect(target.resolve()).resolves.toEqual({ x: 24, y: 18 })
  })

  it("derives bounds targets from the latest bounds", async () => {
    let width = 100
    const target = boundsTarget(async () => ({ x: 10, y: 20, width, height: 40 })).resizeHandle("right")
    width = 160
    await expect(target.resolve()).resolves.toEqual({ x: 170, y: 40 })
  })

  it("rejects duplicate checkpoints", () => {
    expect(() => defineScenario({
      id: scenarioId("canvas.move"),
      title: "Move",
      capabilities: ["editor.canvas.move"],
      adapters: ["browser"],
      evidence: { screenshots: ["held", "held"], video: false },
      run: async () => undefined,
    })).toThrow("unique")
  })

  it("rejects unsafe source paths", () => {
    expect(() => sourcePath("../secret")).toThrow("Invalid source path")
    expect(sourcePath("packages/editor/src/index.ts")).toBe("packages/editor/src/index.ts")
  })
})
