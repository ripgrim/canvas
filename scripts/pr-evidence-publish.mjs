import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { createRequire } from "node:module"
import { basename, dirname, join, relative, resolve } from "node:path"
import { promisify } from "node:util"
import {
  parseEvidenceManifest,
  parseEvidenceRegistry,
  publishEvidence,
  validateTrustedManifest,
} from "../packages/pr-evidence/dist/index.js"

const execute = promisify(execFile)
const root = resolve(import.meta.dirname, "..")
const options = argumentsFrom(process.argv.slice(2))
const artifact = resolve(root, options.artifact ?? "outputs/pr-evidence/download")
const wranglerRoot = dirname(createRequire(import.meta.url).resolve("wrangler/package.json", { paths: [resolve(root, "apps/evidence-service")] }))
const wranglerPackage = JSON.parse(readFileSync(resolve(wranglerRoot, "package.json"), "utf8"))
const wranglerCli = resolve(wranglerRoot, wranglerPackage.bin.wrangler)
const manifestBytes = await readFile(join(artifact, "manifest.json"))
const manifest = parseEvidenceManifest(JSON.parse(manifestBytes.toString("utf8")))
const registry = parseEvidenceRegistry(JSON.parse(await readFile(resolve(root, "tests/pr-evidence/registry.json"), "utf8")))
const repositoryId = positive(required(options, "repository-id"), "repository id")
const repository = required(options, "repository")
const pullRequest = positive(required(options, "pull-request"), "pull request")
const runId = positive(required(options, "run-id"), "run id")
const runAttempt = positive(required(options, "run-attempt"), "run attempt")
const token = requiredEnvironment("GITHUB_TOKEN")
const bucket = requiredEnvironment("PR_EVIDENCE_BUCKET")
const mediaOrigin = exactOrigin(requiredEnvironment("PR_EVIDENCE_MEDIA_ORIGIN"))
const current = await github("GET", `/repos/${repository}/pulls/${pullRequest}`, token)

validateTrustedManifest({
  manifest,
  repositoryId,
  repository,
  pullRequest,
  baseSha: current.base.sha,
  headSha: current.head.sha,
  runId,
  runAttempt,
  adoptionSha: registry.adoptionSha,
  capabilities: registry.capabilities,
  scenarios: registry.scenarios,
})
await verifyArchive(artifact, manifest)

const pullRequests = {
  async read(number) {
    const pull = await github("GET", `/repos/${repository}/pulls/${number}`, token, undefined, "application/vnd.github.full+json")
    return { body: pull.body ?? "", bodyHtml: pull.body_html ?? "", baseSha: pull.base.sha, headSha: pull.head.sha }
  },
  async updateBody(number, body) {
    await github("PATCH", `/repos/${repository}/pulls/${number}`, token, { body })
  },
}

const result = await publishEvidence({
  manifest,
  manifestSha: createHash("sha256").update(manifestBytes).digest("hex"),
  titles: registry.titles,
  assetOrigins: [mediaOrigin],
  pullRequests,
  media: {
    async put(asset) {
      const name = basename(asset.path)
      const key = `${repositoryId}/${name}`
      const path = join(artifact, asset.path)
      const contentType = asset.kind === "video" ? "video/webm" : "image/png"
      await wrangler(["r2", "object", "put", `${bucket}/${key}`, `--file=${path}`, `--content-type=${contentType}`])
      const url = `${mediaOrigin}/${key}`
      const response = await fetch(url, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(30_000) })
      if (!response.ok || Number(response.headers.get("content-length")) !== asset.bytes || response.headers.get("content-type") !== contentType) throw new Error(`Published media failed verification: ${name}`)
      return { sha256: asset.sha256, url }
    },
  },
  async readAsset(path) { return new Uint8Array(await readFile(join(artifact, path))) },
})

process.stdout.write(`${JSON.stringify({ changed: result.changed, assets: result.assets.length })}\n`)

async function verifyArchive(directory, evidence) {
  const actual = await files(directory)
  const expected = ["manifest.json", ...evidence.scenarios.flatMap(scenario => scenario.assets.map(asset => asset.path))].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Evidence archive contains unexpected files.")
}

async function files(directory) {
  const output = []
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Evidence archive contains a symbolic link.")
      const path = join(current, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) output.push(relative(directory, path).replaceAll("\\", "/"))
      else throw new Error("Evidence archive contains an unsupported entry.")
    }
  }
  await visit(directory)
  return output.sort()
}

async function github(method, path, token, body, accept = "application/vnd.github+json") {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { Accept: accept, Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`GitHub returned ${response.status}.`)
  return response.json()
}

async function wrangler(arguments_) {
  try {
    await execute(process.execPath, [wranglerCli, ...arguments_], { cwd: resolve(root, "apps/evidence-service"), timeout: 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
  } catch (error) {
    const detail = error && typeof error === "object" && "stderr" in error ? String(error.stderr).slice(0, 2_000) : String(error)
    throw new Error(`Evidence upload failed: ${detail}`)
  }
}

function argumentsFrom(values) {
  const result = {}
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]
    const value = values[index + 1]
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(`Invalid argument: ${key ?? ""}`)
    const name = key.slice(2)
    if (name in result) throw new Error(`Duplicate argument: ${key}`)
    result[name] = value
  }
  return result
}

function required(input, key) {
  const value = input[key]
  if (!value) throw new Error(`Missing --${key}.`)
  return value
}

function positive(value, label) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Invalid ${label}.`)
  return number
}

function requiredEnvironment(key) {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`Missing ${key}.`)
  return value
}

function exactOrigin(value) {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.origin !== value) throw new Error("PR_EVIDENCE_MEDIA_ORIGIN must be an HTTPS origin.")
  return url.origin
}
