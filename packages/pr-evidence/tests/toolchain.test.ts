import { createHash } from "node:crypto"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { installToolchain, parseToolchainManifest } from "../src/toolchain.js"

const bytes = (value: string) => new TextEncoder().encode(value)
const artifact = (value: string) => ({ url: `https://tools.test/${value}`, sha256: createHash("sha256").update(value).digest("hex"), bytes: value.length })
const manifest = {
  version: 1,
  ffmpegVersion: "6.1.1",
  source: "https://github.com/FFmpeg/FFmpeg/tree/n6.1.1",
  license: artifact("license"),
  readme: artifact("readme"),
  platforms: { "linux-x64": { ffmpeg: artifact("ffmpeg"), ffprobe: artifact("ffprobe") } },
} as const

describe("evidence toolchain", () => {
  it("PR-EVIDENCE-005 installs verified immutable tools", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-evidence-tools-"))
    const downloads: string[] = []
    const installed = await installToolchain({
      manifest: parseToolchainManifest(manifest),
      platform: "linux-x64",
      directory,
      download: async url => { downloads.push(url); return bytes(url.split("/").at(-1) ?? "") },
    })
    expect(downloads).toHaveLength(4)
    expect(await readFile(installed.ffmpeg, "utf8")).toBe("ffmpeg")
    await installToolchain({ manifest: parseToolchainManifest(manifest), platform: "linux-x64", directory, download: async () => { throw new Error("unexpected download") } })
  })

  it("PR-EVIDENCE-NEG-001 rejects corrupt tools and unknown platforms", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-evidence-tools-"))
    await expect(installToolchain({ manifest: parseToolchainManifest(manifest), platform: "linux-arm64", directory, download: async () => bytes("bad") })).rejects.toThrow("Unsupported")
    await expect(installToolchain({ manifest: parseToolchainManifest(manifest), platform: "linux-x64", directory, download: async () => bytes("bad") })).rejects.toThrow("failed verification")
  })
})
