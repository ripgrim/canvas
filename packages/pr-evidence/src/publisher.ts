import { createHash } from "node:crypto"
import type { EvidenceAsset, EvidenceManifest } from "./manifest.js"
import { canonicalJson, planEvidence, type CapabilityDefinition, type EvidenceScenarioDefinition } from "./registry.js"

export const EVIDENCE_START = "<!-- pr-evidence:start -->"
export const EVIDENCE_END = "<!-- pr-evidence:end -->"

export type PublishedAsset = Readonly<{ sha256: string; url: string }>
export type PullRequestSnapshot = Readonly<{ body: string; bodyHtml: string; baseSha: string; headSha: string }>
export type PullRequestPort = Readonly<{
  read(number: number): Promise<PullRequestSnapshot>
  updateBody(number: number, body: string): Promise<void>
}>
export type MediaStorePort = Readonly<{ put(asset: EvidenceAsset, bytes: Uint8Array): Promise<PublishedAsset> }>

export function renderEvidenceBlock(input: Readonly<{
  manifest: EvidenceManifest
  titles: Readonly<Record<string, string>>
  assets: readonly PublishedAsset[]
  manifestSha: string
  assetOrigins?: readonly string[]
}>): string {
  const origins = input.assetOrigins ?? ["https://github.com"]
  const urls = new Map(input.assets.map(asset => [asset.sha256, assetUrl(asset.url, origins)]))
  const lines = [EVIDENCE_START, `<!-- pr-evidence:key:${input.manifest.headSha}:${input.manifestSha} -->`, "", "## Interaction evidence", ""]
  if (!input.manifest.scenarios.length) {
    lines.push("No visual evidence required.", "")
    for (const file of input.manifest.files) lines.push(`- \`${escapeInline(file.path)}\`: ${escapeText(file.reason ?? "Nonvisual change.")}`)
  }
  for (const scenario of input.manifest.scenarios) {
    const title = input.titles[scenario.id]
    if (!title) throw new Error(`Unknown trusted scenario: ${scenario.id}`)
    lines.push(`### ${escapeText(title)}`, "")
    for (const asset of scenario.assets) {
      const url = urls.get(asset.sha256)
      if (!url) throw new Error(`Missing published asset: ${asset.sha256}`)
      if (asset.kind === "video") lines.push(`[Watch ${escapeText(asset.role)} recording](${url})`, "")
      else lines.push(`![${escapeText(asset.role)}](${url})`, "")
    }
    lines.push(`Status: ${scenario.status === "passed" ? "Passed" : "Failed"}`, "")
  }
  lines.push(EVIDENCE_END)
  return `${lines.join("\n").trim()}\n`
}

export function validateTrustedManifest(input: Readonly<{
  manifest: EvidenceManifest
  repositoryId: number
  repository: string
  pullRequest: number
  baseSha: string
  headSha: string
  runId: number
  runAttempt: number
  capabilities: readonly CapabilityDefinition[]
  scenarios: readonly EvidenceScenarioDefinition[]
}>): void {
  const manifest = input.manifest
  const identity = [
    manifest.repository.id === input.repositoryId,
    manifest.repository.fullName === input.repository,
    manifest.pullRequest === input.pullRequest,
    manifest.baseSha === input.baseSha,
    manifest.headSha === input.headSha,
    manifest.run.id === input.runId,
    manifest.run.attempt === input.runAttempt,
  ]
  if (identity.includes(false)) throw new Error("Evidence identity does not match the trusted run.")
  const plan = planEvidence({ changed: manifest.files.map(file => ({ path: file.path })), capabilities: input.capabilities, scenarios: input.scenarios })
  if (plan.registryDigest !== manifest.registryDigest) throw new Error("Evidence registry digest does not match trusted code.")
  if (canonicalJson(plan.files) !== canonicalJson(manifest.files)) throw new Error("Evidence file plan does not match trusted code.")
  const expected = new Map(plan.scenarios.flatMap(scenario => scenario.adapters.map(adapter => [`${scenario.id}:${adapter}`, scenario] as const)))
  if (expected.size !== manifest.scenarios.length) throw new Error("Evidence scenarios do not match the trusted plan.")
  for (const scenario of manifest.scenarios) {
    const definition = expected.get(`${scenario.id}:${scenario.adapter}`)
    if (!definition) throw new Error("Evidence scenario is not trusted.")
    if (scenario.status !== "passed") throw new Error("Evidence scenario did not pass.")
    if (canonicalJson(definition.assertions) !== canonicalJson(scenario.assertions)) throw new Error("Evidence assertions do not match trusted code.")
    const roles = [...definition.screenshots, ...(definition.video ? ["poster", "interaction"] : [])].sort()
    if (canonicalJson(roles) !== canonicalJson(scenario.assets.map(asset => asset.role).sort())) throw new Error("Evidence assets do not match trusted code.")
  }
}

export async function publishEvidence(input: Readonly<{
  manifest: EvidenceManifest
  manifestSha: string
  titles: Readonly<Record<string, string>>
  assetOrigins: readonly string[]
  pullRequests: PullRequestPort
  media: MediaStorePort
  readAsset(path: string): Promise<Uint8Array>
}>): Promise<Readonly<{ changed: boolean; body: string; assets: readonly PublishedAsset[] }>> {
  const published: PublishedAsset[] = []
  for (const scenario of input.manifest.scenarios) {
    for (const asset of scenario.assets) {
      const bytes = await input.readAsset(asset.path)
      const digest = createHash("sha256").update(bytes).digest("hex")
      if (bytes.byteLength !== asset.bytes || digest !== asset.sha256) throw new Error(`Evidence asset failed verification: ${asset.path}`)
      const result = await input.media.put(asset, bytes)
      if (result.sha256 !== asset.sha256) throw new Error("Media store returned the wrong asset.")
      const expectedSuffix = `/${asset.sha256}.${asset.kind === "video" ? "webm" : "png"}`
      if (!new URL(result.url).pathname.endsWith(expectedSuffix)) throw new Error("Media store returned the wrong asset URL.")
      published.push(Object.freeze({ sha256: result.sha256, url: assetUrl(result.url, input.assetOrigins) }))
    }
  }
  const current = await input.pullRequests.read(input.manifest.pullRequest)
  if (current.baseSha !== input.manifest.baseSha || current.headSha !== input.manifest.headSha) throw new Error("Evidence is stale for the current pull request.")
  const block = renderEvidenceBlock({ manifest: input.manifest, titles: input.titles, assets: published, manifestSha: input.manifestSha, assetOrigins: input.assetOrigins })
  const body = replaceEvidenceBlock(current.body, block)
  if (body === current.body) return Object.freeze({ changed: false, body, assets: Object.freeze(published) })
  const beforeWrite = await input.pullRequests.read(input.manifest.pullRequest)
  if (beforeWrite.body !== current.body || beforeWrite.baseSha !== current.baseSha || beforeWrite.headSha !== current.headSha) throw new Error("Pull request changed during evidence publication.")
  await input.pullRequests.updateBody(input.manifest.pullRequest, body)
  const verified = await input.pullRequests.read(input.manifest.pullRequest)
  if (verified.body !== body || !verified.body.includes(`pr-evidence:key:${input.manifest.headSha}:${input.manifestSha}`)) throw new Error("Published evidence could not be verified.")
  for (const asset of published) if (!verified.bodyHtml.includes(asset.url)) throw new Error("Published evidence media could not be verified.")
  return Object.freeze({ changed: true, body, assets: Object.freeze(published) })
}

export function replaceEvidenceBlock(body: string, block: string): string {
  const start = body.indexOf(EVIDENCE_START)
  const end = body.indexOf(EVIDENCE_END)
  if (start === -1 && end === -1) return body.trimEnd() ? `${body.trimEnd()}\n\n${block}` : block
  if (start === -1 || end === -1 || end < start) throw new Error("PR body contains incomplete evidence markers.")
  if (body.indexOf(EVIDENCE_START, start + EVIDENCE_START.length) !== -1 || body.indexOf(EVIDENCE_END, end + EVIDENCE_END.length) !== -1) throw new Error("PR body contains duplicate evidence markers.")
  const prefix = body.slice(0, start).trimEnd()
  const suffix = body.slice(end + EVIDENCE_END.length).trim()
  return `${[prefix, block.trim(), suffix].filter(Boolean).join("\n\n")}\n`
}

function assetUrl(value: string, allowedOrigins: readonly string[]): string {
  const url = new URL(value)
  const origins = allowedOrigins.map(value => {
    const allowed = new URL(value)
    if (allowed.protocol !== "https:" || allowed.origin !== value) throw new Error("Invalid evidence asset origin.")
    return allowed.origin
  })
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !origins.includes(url.origin)) throw new Error("Invalid evidence asset URL.")
  if (url.origin === "https://github.com" && !url.pathname.startsWith("/user-attachments/assets/")) throw new Error("Invalid GitHub attachment URL.")
  return url.href
}

function escapeText(value: string): string {
  return value.replace(/[<>&]/gu, character => character === "<" ? "&lt;" : character === ">" ? "&gt;" : "&amp;")
}

function escapeInline(value: string): string {
  return escapeText(value.replaceAll("`", ""))
}
