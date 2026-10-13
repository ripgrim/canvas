import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"

export type ToolArtifact = Readonly<{
  url: string
  sha256: string
  bytes: number
}>

export type ToolchainManifest = Readonly<{
  version: 1
  ffmpegVersion: string
  source: string
  platforms: Readonly<Record<string, Readonly<{
    ffmpeg: ToolArtifact
    ffprobe: ToolArtifact
    license: ToolArtifact
    readme: ToolArtifact
  }>>>
}>

export type DownloadPort = (url: string) => Promise<Uint8Array>

export function parseToolchainManifest(value: unknown): ToolchainManifest {
  const root = exactObject(value, ["version", "ffmpegVersion", "source", "platforms"], "toolchain")
  if (root.version !== 1) throw new Error("Unsupported toolchain version.")
  if (typeof root.ffmpegVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(root.ffmpegVersion)) throw new Error("Invalid FFmpeg version.")
  if (typeof root.source !== "string" || new URL(root.source).protocol !== "https:") throw new Error("Invalid FFmpeg source URL.")
  const platforms = recordObject(root.platforms, "platforms")
  const parsedPlatforms = Object.fromEntries(Object.entries(platforms).map(([key, entry]) => {
    if (!/^(linux|darwin|win32)-(x64|arm64)$/u.test(key)) throw new Error(`Invalid toolchain platform: ${key}`)
    const tools = exactObject(entry, ["ffmpeg", "ffprobe", "license", "readme"], `platform ${key}`)
    return [key, Object.freeze({
      ffmpeg: artifact(tools.ffmpeg),
      ffprobe: artifact(tools.ffprobe),
      license: artifact(tools.license),
      readme: artifact(tools.readme),
    })]
  }))
  if (!Object.keys(parsedPlatforms).length) throw new Error("The toolchain has no platforms.")
  return Object.freeze({
    version: 1,
    ffmpegVersion: root.ffmpegVersion,
    source: root.source,
    platforms: Object.freeze(parsedPlatforms),
  })
}

export async function installToolchain(input: Readonly<{
  manifest: ToolchainManifest
  platform: string
  directory: string
  download: DownloadPort
}>): Promise<Readonly<{ ffmpeg: string; ffprobe: string; license: string; readme: string }>> {
  const selected = input.manifest.platforms[input.platform]
  if (!selected) throw new Error(`Unsupported toolchain platform: ${input.platform}`)
  const directory = resolve(input.directory)
  const executable = input.platform.startsWith("win32-") ? ".exe" : ""
  const targets = {
    ffmpeg: resolve(directory, `ffmpeg${executable}`),
    ffprobe: resolve(directory, `ffprobe${executable}`),
    license: resolve(directory, "LICENSE.ffmpeg"),
    readme: resolve(directory, "README.ffmpeg"),
  }
  await mkdir(directory, { recursive: true })
  await Promise.all([
    installArtifact(selected.ffmpeg, targets.ffmpeg, input.download, true),
    installArtifact(selected.ffprobe, targets.ffprobe, input.download, true),
    installArtifact(selected.license, targets.license, input.download, false),
    installArtifact(selected.readme, targets.readme, input.download, false),
  ])
  return Object.freeze(targets)
}

async function installArtifact(expected: ToolArtifact, target: string, download: DownloadPort, executable: boolean) {
  const existing = await readFile(target).catch(() => null)
  if (existing && verified(existing, expected)) {
    if (executable) await chmod(target, 0o755)
    return
  }
  const bytes = await download(expected.url)
  if (!verified(bytes, expected)) throw new Error(`Tool artifact failed verification: ${basename(target)}`)
  const temporary = `${target}.${process.pid}.tmp`
  await mkdir(dirname(target), { recursive: true })
  await writeFile(temporary, bytes, { flag: "wx" })
  try {
    if (executable) await chmod(temporary, 0o755)
    await rm(target, { force: true })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
}

function artifact(value: unknown): ToolArtifact {
  const item = exactObject(value, ["url", "sha256", "bytes"], "artifact")
  if (typeof item.url !== "string" || new URL(item.url).protocol !== "https:") throw new Error("Invalid tool URL.")
  if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(item.sha256)) throw new Error("Invalid tool SHA.")
  if (!Number.isSafeInteger(item.bytes) || (item.bytes as number) <= 0) throw new Error("Invalid tool size.")
  return Object.freeze({ url: item.url, sha256: item.sha256, bytes: item.bytes as number })
}

function verified(bytes: Uint8Array, expected: ToolArtifact) {
  return bytes.byteLength === expected.bytes && createHash("sha256").update(bytes).digest("hex") === expected.sha256
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}.`)
  const item = value as Record<string, unknown>
  if (Object.keys(item).some(key => !keys.includes(key)) || keys.some(key => !(key in item))) throw new Error(`Invalid ${label} keys.`)
  return item
}

function recordObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}.`)
  return value as Record<string, unknown>
}
