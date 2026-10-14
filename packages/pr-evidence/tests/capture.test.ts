import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { pngDimensions, readRecordingCrop } from "../src/capture.js"

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

  it("PR-EVIDENCE-011 validates recording crop metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "canvas-recording-"))
    const path = join(directory, "recording.json")
    try {
      await writeFile(path, JSON.stringify({ crop: {
        viewport: { width: 1500, height: 940 },
        source: { x: 648, y: 410, width: 205, height: 84 },
        output: { width: 229, height: 108, offsetX: 12, offsetY: 12 },
        background: "#202124",
      } }))
      await expect(readRecordingCrop(path)).resolves.toEqual({
        viewport: { width: 1500, height: 940 },
        source: { x: 648, y: 410, width: 205, height: 84 },
        output: { width: 229, height: 108, offsetX: 12, offsetY: 12 },
        background: "#202124",
      })
      await writeFile(path, JSON.stringify({ crop: {
        viewport: { width: 1500, height: 940 },
        source: { x: 1490, y: 0, width: 20, height: 20 },
        output: { width: 20, height: 20, offsetX: 0, offsetY: 0 },
        background: "#202124",
      } }))
      await expect(readRecordingCrop(path)).rejects.toThrow("Invalid recording crop metadata")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
