import { createHash } from "node:crypto"
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { EVIDENCE_SCHEMA_VERSION, parseEvidenceManifest, type EvidenceAsset, type EvidenceManifest, type ScenarioEvidence } from "./manifest.js"
import { normalizeEvidenceVideo, type ProcessPort } from "./media.js"
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
        const poster = join(source, "poster.png")
        const result = await normalizeEvidenceVideo({ ffmpeg: input.ffmpeg, ffprobe: input.ffprobe, source: join(source, "raw.webm"), destination: normalized, poster, run: input.run })
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
