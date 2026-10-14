export const EVIDENCE_SCHEMA_VERSION = 1 as const

export type EvidenceAsset = Readonly<{
  path: `media/${string}.${"png" | "webm"}`
  kind: "screenshot" | "video"
  role: string
  sha256: string
  bytes: number
  width: number
  height: number
  durationMs?: number
  sourceFrames?: number
  observedFps?: number
}>

export type ScenarioEvidence = Readonly<{
  id: string
  adapter: "browser" | "electron"
  status: "passed" | "failed"
  assertions: readonly string[]
  assets: readonly EvidenceAsset[]
}>

export type EvidenceManifest = Readonly<{
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION
  repository: Readonly<{ id: number; fullName: string }>
  pullRequest: number
  baseSha: string
  headSha: string
  run: Readonly<{ id: number; attempt: number }>
  registryDigest: string
  files: readonly Readonly<{ path: string; capabilities: readonly string[]; evidence: "visual" | "nonvisual"; reason?: string }>[]
  scenarios: readonly ScenarioEvidence[]
}>

const SHA = /^[a-f0-9]{64}$/u
const GIT_SHA = /^[a-f0-9]{40}$/u
const ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/u
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u

export function parseEvidenceManifest(value: unknown): EvidenceManifest {
  const root = object(value, ["schemaVersion", "repository", "pullRequest", "baseSha", "headSha", "run", "registryDigest", "files", "scenarios"], "manifest")
  if (root.schemaVersion !== EVIDENCE_SCHEMA_VERSION) throw new Error("Unsupported evidence manifest version.")
  const repository = object(root.repository, ["id", "fullName"], "repository")
  const run = object(root.run, ["id", "attempt"], "run")
  const files = array(root.files, "files").map((item, index) => file(item, index))
  const scenarios = array(root.scenarios, "scenarios").map((item, index) => scenario(item, index))
  unique(scenarios.map(item => `${item.id}:${item.adapter}`), "scenario")
  consistentAssets(scenarios.flatMap(item => item.assets))
  return Object.freeze({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    repository: Object.freeze({ id: positive(repository.id, "repository id"), fullName: match(repository.fullName, REPOSITORY, "repository full name") }),
    pullRequest: positive(root.pullRequest, "pull request"),
    baseSha: match(root.baseSha, GIT_SHA, "base SHA"),
    headSha: match(root.headSha, GIT_SHA, "head SHA"),
    run: Object.freeze({ id: positive(run.id, "run id"), attempt: positive(run.attempt, "run attempt") }),
    registryDigest: match(root.registryDigest, SHA, "registry digest"),
    files: Object.freeze(files),
    scenarios: Object.freeze(scenarios),
  })
}

function file(value: unknown, index: number): EvidenceManifest["files"][number] {
  const item = object(value, ["path", "capabilities", "evidence", "reason"], `file ${index}`, ["reason"])
  const path = safePath(string(item.path, "file path"), false)
  const capabilities = array(item.capabilities, "file capabilities").map(value => match(value, ID, "capability id"))
  unique(capabilities, "capability id")
  if (item.evidence !== "visual" && item.evidence !== "nonvisual") throw new Error("Invalid evidence kind.")
  if (item.evidence === "nonvisual" && !string(item.reason, "nonvisual reason").trim()) throw new Error("Nonvisual evidence requires a reason.")
  if (item.evidence === "visual" && item.reason !== undefined) throw new Error("Visual evidence cannot have a nonvisual reason.")
  return Object.freeze({ path, capabilities: Object.freeze(capabilities), evidence: item.evidence, ...(typeof item.reason === "string" ? { reason: item.reason } : {}) })
}

function scenario(value: unknown, index: number): ScenarioEvidence {
  const item = object(value, ["id", "adapter", "status", "assertions", "assets"], `scenario ${index}`)
  if (item.adapter !== "browser" && item.adapter !== "electron") throw new Error("Invalid scenario adapter.")
  if (item.status !== "passed" && item.status !== "failed") throw new Error("Invalid scenario status.")
  const assertions = array(item.assertions, "assertions").map(value => match(value, ID, "assertion id"))
  const assets = array(item.assets, "assets").map((asset, assetIndex) => evidenceAsset(asset, assetIndex))
  unique(assertions, "assertion id")
  unique(assets.map(asset => asset.role), "asset role")
  return Object.freeze({ id: match(item.id, ID, "scenario id"), adapter: item.adapter, status: item.status, assertions: Object.freeze(assertions), assets: Object.freeze(assets) })
}

function evidenceAsset(value: unknown, index: number): EvidenceAsset {
  const item = object(value, ["path", "kind", "role", "sha256", "bytes", "width", "height", "durationMs", "sourceFrames", "observedFps"], `asset ${index}`, ["durationMs", "sourceFrames", "observedFps"])
  if (item.kind !== "screenshot" && item.kind !== "video") throw new Error("Invalid asset kind.")
  const path = safePath(string(item.path, "asset path"), true)
  const extension = path.endsWith(".png") ? "screenshot" : path.endsWith(".webm") ? "video" : null
  if (extension !== item.kind) throw new Error("Asset kind does not match its extension.")
  const sha256 = match(item.sha256, SHA, "asset SHA")
  if (path !== `media/${sha256}.${item.kind === "video" ? "webm" : "png"}`) throw new Error("Asset path does not match its SHA.")
  const durationMs = item.durationMs === undefined ? undefined : finite(item.durationMs, "durationMs")
  const sourceFrames = item.sourceFrames === undefined ? undefined : finite(item.sourceFrames, "sourceFrames")
  const observedFps = item.observedFps === undefined ? undefined : finite(item.observedFps, "observedFps")
  return Object.freeze({
    path: path as EvidenceAsset["path"], kind: item.kind, role: match(item.role, ID, "asset role"), sha256,
    bytes: positive(item.bytes, "asset bytes"), width: positive(item.width, "asset width"), height: positive(item.height, "asset height"),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(sourceFrames !== undefined ? { sourceFrames } : {}),
    ...(observedFps !== undefined ? { observedFps } : {}),
  })
}

function object(value: unknown, keys: readonly string[], label: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}.`)
  const record = value as Record<string, unknown>
  const actual = Object.keys(record)
  if (actual.some(key => !keys.includes(key)) || keys.some(key => !optional.includes(key) && !(key in record))) throw new Error(`Invalid ${label} keys.`)
  return record
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}.`)
  return value
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}.`)
  return value
}

function match(value: unknown, expression: RegExp, label: string): string {
  const result = string(value, label)
  if (!expression.test(result)) throw new Error(`Invalid ${label}.`)
  return result
}

function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`Invalid ${label}.`)
  return value as number
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}.`)
  return value
}

function safePath(value: string, media: boolean): string {
  const parts = value.split("/")
  if (!value || value.startsWith("/") || /^[A-Za-z]:/u.test(value) || value.includes("\\") || value.includes("\0") || parts.some(part => !part || part === "." || part === "..")) throw new Error("Unsafe evidence path.")
  if (media && (parts.length !== 2 || parts[0] !== "media" || !/^([a-f0-9]{64})\.(png|webm)$/u.test(parts[1] ?? ""))) throw new Error("Invalid media path.")
  return value
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}.`)
}

function consistentAssets(assets: readonly EvidenceAsset[]): void {
  const found = new Map<string, EvidenceAsset>()
  for (const asset of assets) {
    const existing = found.get(asset.path)
    if (!existing) {
      found.set(asset.path, asset)
      continue
    }
    if (existing.kind !== asset.kind || existing.sha256 !== asset.sha256 || existing.bytes !== asset.bytes || existing.width !== asset.width || existing.height !== asset.height || existing.durationMs !== asset.durationMs || existing.sourceFrames !== asset.sourceFrames || existing.observedFps !== asset.observedFps) {
      throw new Error("Conflicting asset metadata.")
    }
  }
}
