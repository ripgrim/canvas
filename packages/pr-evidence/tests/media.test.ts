import { describe, expect, it } from "vitest"
import { inspectEvidenceVideo, type ProcessPort, videoCropFilter } from "../src/media.js"

const probe = JSON.stringify({ streams: [{ width: 1500, height: 940, nb_read_frames: "42", avg_frame_rate: "25/1" }], format: { duration: "1.680000" } })

describe("evidence media", () => {
  it("PR-EVIDENCE-005 validates decoded motion and dimensions", async () => {
    const run: ProcessPort = async (executable, arguments_) => {
      if (executable === "ffprobe") return { code: 0, stdout: probe, stderr: "" }
      if (arguments_.includes("framemd5")) return { code: 0, stdout: "0, 0, 0, 1, a\n0, 1, 1, 1, b\n", stderr: "" }
      if (arguments_.includes("signalstats,metadata=print:file=-")) return { code: 0, stdout: "lavfi.signalstats.YAVG=24.5\n", stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    }
    await expect(inspectEvidenceVideo({ ffmpeg: "ffmpeg", ffprobe: "ffprobe", path: "capture.webm", run })).resolves.toEqual({ width: 1500, height: 940, durationMs: 1680, frames: 42, observedFps: 25, meanLuma: 24.5, uniqueFrames: 2 })
  })

  it("PR-EVIDENCE-NEG-001 rejects static and blank video", async () => {
    const staticRun: ProcessPort = async (executable, arguments_) => {
      if (executable === "ffprobe") return { code: 0, stdout: probe, stderr: "" }
      if (arguments_.includes("framemd5")) return { code: 0, stdout: "0, 0, 0, 1, a\n0, 1, 1, 1, a\n", stderr: "" }
      return { code: 0, stdout: "lavfi.signalstats.YAVG=0\n", stderr: "" }
    }
    await expect(inspectEvidenceVideo({ ffmpeg: "ffmpeg", ffprobe: "ffprobe", path: "capture.webm", run: staticRun })).rejects.toThrow("no visible motion")
  })

  it("PR-EVIDENCE-011 crops and pads recordings deterministically", () => {
    expect(videoCropFilter({
      viewport: { width: 1500, height: 940 },
      source: { x: 0, y: 12, width: 240, height: 120 },
      output: { width: 264, height: 144, offsetX: 12, offsetY: 12 },
      background: "#181818",
    }, { width: 800, height: 500 })).toBe("format=rgb24,crop=w=128:h=65:x=0:y=6:exact=1,scale=240:120:flags=lanczos,format=rgb24,pad=264:144:12:12:color=#181818,format=yuv420p")
  })
})
