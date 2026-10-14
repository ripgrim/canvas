import { describe, expect, it } from "vitest"
import type { Page } from "@playwright/test"
import { boundsTarget, defineScenario, geometryTarget, nodeId, scenarioId, sourcePath, type NodeRef } from "../src/index.js"
import { resolveRecordingOptions, resolveScreenshotOptions } from "../src/playwright.js"

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

  it("resolves an exact dimension crop around a typed target", async () => {
    const page = fakePage(900, 600)
    await expect(resolveRecordingOptions(page, {
      crop: { kind: "dimensions", width: 320, height: 180, center: geometryTarget(async () => ({ x: 200, y: 100 })) },
    })).resolves.toEqual({
      crop: {
        viewport: { width: 900, height: 600 },
        source: { x: 40, y: 10, width: 320, height: 180 },
        output: { width: 320, height: 180, offsetX: 0, offsetY: 0 },
        background: "#181818",
      },
    })
  })

  it("pads a node crop beyond the viewport with the theme background", async () => {
    const page = fakePage(900, 600)
    const node = {
      id: nodeId("text-1"),
      resolve: async () => ({ id: nodeId("text-1"), kind: "text" as const, name: "Text", bounds: { x: 5, y: 8, width: 80, height: 20 } }),
      bounds: () => boundsTarget(async () => ({ x: 5, y: 8, width: 80, height: 20 })),
      center: () => geometryTarget(async () => ({ x: 45, y: 18 })),
      overlay: async () => ({ bounds: { x: 5, y: 8, width: 80, height: 20 }, resizeHandles: [], rotationHandles: [] }),
      expectKind: async () => node,
    } as unknown as NodeRef
    await expect(resolveRecordingOptions(page, { crop: { kind: "node", node, padding: 16 } })).resolves.toEqual({
      crop: {
        viewport: { width: 900, height: 600 },
        source: { x: 0, y: 0, width: 101, height: 44 },
        output: { width: 112, height: 52, offsetX: 11, offsetY: 8 },
        background: "#181818",
      },
    })
  })

  it("resolves a two-times compositor screenshot crop", async () => {
    const page = fakePage(900, 600)
    await expect(resolveScreenshotOptions(page, {
      crop: { kind: "dimensions", width: 320, height: 180, center: geometryTarget(async () => ({ x: 450, y: 300 })) },
      scale: 2,
    })).resolves.toEqual({
      scale: 2,
      crop: {
        viewport: { width: 900, height: 600 },
        source: { x: 290, y: 210, width: 320, height: 180 },
        output: { width: 320, height: 180, offsetX: 0, offsetY: 0 },
        background: "#181818",
      },
    })
  })
})

function fakePage(width: number, height: number): Page {
  return {
    viewportSize: () => ({ width, height }),
    evaluate: async () => "#181818",
    locator: () => ({ evaluate: async () => ({ x: width / 2, y: height / 2 }) }),
  } as unknown as Page
}
