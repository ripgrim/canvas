import { createHash } from "node:crypto"
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { EVIDENCE_SCHEMA_VERSION, parseEvidenceManifest, type EvidenceAsset, type EvidenceManifest, type ScenarioEvidence } from "./manifest.js"
import { normalizeEvidenceVideo, type ProcessPort } from "./media.js"
import type { ResolvedCaptureCrop } from "@canvas/editor-automation"
import { canonicalJson, type EvidencePlan } from "./registry.js"

export type EvidenceRunIdentity = Readonly<{
  repositoryId: number
  repository: string
  pullRequest: number
  baseSha: string
  headSha: string
  runId: number
  runAttempt: number
}>

export async function collectEvidenceArtifact(input: Readonly<{
  plan: EvidencePlan
  identity: EvidenceRunIdentity
  captures: string
  artifact: string
  ffmpeg: string
  ffprobe: string
  run: ProcessPort
}>): Promise<EvidenceManifest> {
  const captures = resolve(input.captures)
  const artifact = resolve(input.artifact)
  const media = join(artifact, "media")
  await rm(artifact, { recursive: true, force: true })
  await mkdir(media, { recursive: true })
  const scenarios: ScenarioEvidence[] = []
  for (const scenario of input.plan.scenarios) {
    for (const adapter of scenario.adapters) {
      const source = join(captures, scenario.id, adapter)
      const assets: EvidenceAsset[] = []
      for (const role of scenario.screenshots) assets.push(await storePng(join(source, `${role}.png`), role, media))
      if (scenario.video) {
        const normalized = join(source, "normalized.webm")
        const poster = join(source, "normalized-poster.png")
        const posterSource = await optionalFile(join(source, "poster.png"))
        const crop = await readRecordingCrop(join(source, "recording.json"))
        const result = await normalizeEvidenceVideo({ ffmpeg: input.ffmpeg, ffprobe: input.ffprobe, source: join(source, "raw.webm"), destination: normalized, poster, run: input.run, ...(crop ? { crop } : {}), ...(posterSource ? { posterSource } : {}) })
        await copyFile(normalized, join(media, basename(result.video.path)))
        await copyFile(poster, join(media, basename(result.poster.path)))
        assets.push(result.poster, result.video)
      }
      scenarios.push(Object.freeze({ id: scenario.id, adapter, status: "passed", assertions: scenario.assertions, assets: Object.freeze(assets) }))
    }
  }
  const manifest = parseEvidenceManifest({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    repository: { id: input.identity.repositoryId, fullName: input.identity.repository },
    pullRequest: input.identity.pullRequest,
    baseSha: input.identity.baseSha,
    headSha: input.identity.headSha,
    run: { id: input.identity.runId, attempt: input.identity.runAttempt },
    registryDigest: input.plan.registryDigest,
    files: input.plan.files,
    scenarios,
  })
  await writeFile(join(artifact, "manifest.json"), canonicalJson(manifest))
  return manifest
}

export async function readRecordingCrop(path: string): Promise<ResolvedCaptureCrop | undefined> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  const value = JSON.parse(raw) as { crop?: unknown }
  if (value.crop === undefined) return undefined
  const crop = value.crop as Partial<ResolvedCaptureCrop>
  const viewport = crop.viewport as Partial<ResolvedCaptureCrop["viewport"]> | undefined
  const source = crop.source as Partial<ResolvedCaptureCrop["source"]> | undefined
  const output = crop.output as Partial<ResolvedCaptureCrop["output"]> | undefined
  if (!viewport || !source || !output || ![viewport.width, viewport.height, source.x, source.y, source.width, source.height, output.width, output.height, output.offsetX, output.offsetY].every(Number.isSafeInteger)) {
    throw new Error("Invalid recording crop metadata.")
  }
  if ((viewport.width ?? 0) <= 0 || (viewport.height ?? 0) <= 0 || (source.width ?? 0) <= 0 || (source.height ?? 0) <= 0 || (output.width ?? 0) <= 0 || (output.height ?? 0) <= 0 || (source.x ?? -1) < 0 || (source.y ?? -1) < 0 || (output.offsetX ?? -1) < 0 || (output.offsetY ?? -1) < 0 || typeof crop.background !== "string" || !/^#[\da-f]{6}$/iu.test(crop.background)) {
    throw new Error("Invalid recording crop metadata.")
  }
  if (source.x! + source.width! > viewport.width! || source.y! + source.height! > viewport.height! || output.offsetX! + source.width! > output.width! || output.offsetY! + source.height! > output.height! || output.width! > 8192 || output.height! > 8192) {
    throw new Error("Invalid recording crop metadata.")
  }
  return Object.freeze({
    viewport: Object.freeze({ width: viewport.width!, height: viewport.height! }),
    source: Object.freeze({ x: source.x!, y: source.y!, width: source.width!, height: source.height! }),
    output: Object.freeze({ width: output.width!, height: output.height!, offsetX: output.offsetX!, offsetY: output.offsetY! }),
    background: crop.background as `#${string}`,
  })
}

async function optionalFile(path: string): Promise<string | undefined> {
  try {
    await readFile(path)
    return path
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function storePng(path: string, role: string, directory: string): Promise<EvidenceAsset> {
  const bytes = await readFile(path)
  const { width, height } = pngDimensions(bytes)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const target = join(directory, `${sha256}.png`)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(path, target)
  return Object.freeze({ path: `media/${sha256}.png`, kind: "screenshot", role, sha256, bytes: bytes.byteLength, width, height })
}

export function pngDimensions(bytes: Uint8Array): Readonly<{ width: number; height: number }> {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (bytes.byteLength < 24 || signature.some((value, index) => bytes[index] !== value)) throw new Error("Invalid PNG evidence.")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (!width || !height) throw new Error("Invalid PNG dimensions.")
  return Object.freeze({ width, height })
}
