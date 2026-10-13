import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import type { EvidenceAsset } from "./manifest.js"

export type ProcessResult = Readonly<{ code: number; stdout: string; stderr: string }>
export type ProcessPort = (executable: string, arguments_: readonly string[]) => Promise<ProcessResult>

export type VideoInspection = Readonly<{
  width: number
  height: number
  durationMs: number
  frames: number
  observedFps: number
  meanLuma: number
  uniqueFrames: number
}>

export async function normalizeEvidenceVideo(input: Readonly<{
  ffmpeg: string
  ffprobe: string
  source: string
  destination: string
  poster: string
  run: ProcessPort
  maxDurationMs?: number
  maxBytes?: number
}>): Promise<Readonly<{ video: EvidenceAsset; poster: EvidenceAsset; inspection: VideoInspection }>> {
  const source = resolve(input.source)
  const destination = resolve(input.destination)
  const poster = resolve(input.poster)
  await successful(input.run(input.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", source,
    "-map", "0:v:0", "-an", "-map_metadata", "-1", "-c:v", "libvpx-vp9",
    "-deadline", "good", "-cpu-used", "2", "-crf", "35", "-b:v", "0",
    "-pix_fmt", "yuv420p", "-fps_mode", "vfr", destination,
  ]), "FFmpeg normalization")
  const inspection = await inspectEvidenceVideo({ ffmpeg: input.ffmpeg, ffprobe: input.ffprobe, path: destination, run: input.run })
  if (inspection.durationMs > (input.maxDurationMs ?? 30_000)) throw new Error("Evidence video exceeds the duration limit.")
  const videoBytes = (await stat(destination)).size
  if (videoBytes > (input.maxBytes ?? 9 * 1024 * 1024)) throw new Error("Evidence video exceeds the size limit.")
  await successful(input.run(input.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", destination,
    "-map", "0:v:0", "-frames:v", "1", "-pix_fmt", "rgb24", poster,
  ]), "FFmpeg poster extraction")
  const video = await evidenceAsset(destination, "video", "interaction", inspection)
  const posterAsset = await evidenceAsset(poster, "screenshot", "poster", inspection)
  return Object.freeze({ video, poster: posterAsset, inspection })
}

export async function inspectEvidenceVideo(input: Readonly<{
  ffmpeg: string
  ffprobe: string
  path: string
  run: ProcessPort
}>): Promise<VideoInspection> {
  const probe = await successful(input.run(input.ffprobe, [
    "-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=width,height,nb_read_frames,avg_frame_rate:format=duration",
    "-of", "json", resolve(input.path),
  ]), "FFprobe inspection")
  const parsed = JSON.parse(probe.stdout) as { streams?: Array<{ width?: number; height?: number; nb_read_frames?: string; avg_frame_rate?: string }>; format?: { duration?: string } }
  const stream = parsed.streams?.[0]
  const width = integer(stream?.width, "video width")
  const height = integer(stream?.height, "video height")
  const frames = integer(Number(stream?.nb_read_frames), "video frame count")
  const durationMs = finite(Number(parsed.format?.duration) * 1000, "video duration")
  const observedFps = ratio(stream?.avg_frame_rate)
  const decoded = await successful(input.run(input.ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", resolve(input.path), "-f", "null", "-"]), "FFmpeg decode")
  if (decoded.code !== 0) throw new Error("Evidence video could not be decoded.")
  const hashes = await successful(input.run(input.ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", resolve(input.path), "-map", "0:v:0", "-f", "framemd5", "-"]), "FFmpeg frame hash")
  const uniqueFrames = new Set(hashes.stdout.split(/\r?\n/u).filter(line => /^\d+,/u.test(line)).map(line => line.split(",").at(-1)?.trim())).size
  if (uniqueFrames < 2) throw new Error("Evidence video contains no visible motion.")
  const signal = await successful(input.run(input.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-i", resolve(input.path),
    "-vf", "signalstats,metadata=print:file=-", "-frames:v", "1", "-f", "null", "-",
  ]), "FFmpeg signal inspection")
  const meanLuma = finite(Number(/lavfi\.signalstats\.YAVG=([\d.]+)/u.exec(signal.stdout)?.[1]), "mean luma")
  if (meanLuma <= 1 || meanLuma >= 254) throw new Error("Evidence video is blank.")
  return Object.freeze({ width, height, durationMs, frames, observedFps, meanLuma, uniqueFrames })
}

async function evidenceAsset(path: string, kind: "screenshot" | "video", role: string, inspection: VideoInspection): Promise<EvidenceAsset> {
  const bytes = await readFile(path)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  return Object.freeze({
    path: `media/${sha256}.${kind === "video" ? "webm" : "png"}`,
    kind,
    role,
    sha256,
    bytes: bytes.byteLength,
    width: inspection.width,
    height: inspection.height,
    ...(kind === "video" ? { durationMs: inspection.durationMs, sourceFrames: inspection.frames, observedFps: inspection.observedFps } : {}),
  })
}

async function successful(input: Promise<ProcessResult>, label: string) {
  const result = await input
  if (result.code !== 0) throw new Error(`${label} failed: ${result.stderr.slice(0, 2_000)}`)
  return result
}

function integer(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`Invalid ${label}.`)
  return value as number
}

function finite(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${label}.`)
  return value
}

function ratio(value: string | undefined) {
  const [left, right] = value?.split("/").map(Number) ?? []
  return finite((left ?? 0) / (right ?? 0), "observed FPS")
}
