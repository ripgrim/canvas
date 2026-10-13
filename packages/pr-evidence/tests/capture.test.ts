import { describe, expect, it } from "vitest"
import { pngDimensions } from "../src/capture.js"

describe("evidence capture", () => {
  it("PR-EVIDENCE-003 reads independent PNG dimensions", () => {
    const png = new Uint8Array(24)
    png.set([137, 80, 78, 71, 13, 10, 26, 10])
    new DataView(png.buffer).setUint32(16, 1500)
    new DataView(png.buffer).setUint32(20, 940)
    expect(pngDimensions(png)).toEqual({ width: 1500, height: 940 })
  })

  it("PR-EVIDENCE-NEG-001 rejects invalid PNG input", () => {
    expect(() => pngDimensions(new Uint8Array(24))).toThrow("Invalid PNG")
  })
})
