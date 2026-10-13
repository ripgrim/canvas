import { execFileSync } from "node:child_process"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  canonicalJson,
  collectEvidenceArtifact,
  createProcessRunner,
  installToolchain,
  parseEvidenceRegistry,
  parseGitNameStatus,
  parseToolchainManifest,
  planEvidence,
} from "../packages/pr-evidence/dist/index.js"

const root = resolve(import.meta.dirname, "..")
const options = argumentsFrom(process.argv.slice(3))
const command = process.argv[2]

if (command === "plan") await plan()
else if (command === "toolchain") await toolchain()
else if (command === "collect") await collect()
else throw new Error("Expected plan, toolchain, or collect.")

async function plan() {
  const registry = await readRegistry()
  const base = required(options, "base")
  const head = required(options, "head")
  const output = resolve(root, options.output ?? "outputs/pr-evidence/plan.json")
  const changed = options["changed-json"]
    ? JSON.parse(options["changed-json"])
    : parseGitNameStatus(execFileSync("git", ["diff", "--name-status", "-z", "--find-renames", `${base}...${head}`], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }))
  if (!Array.isArray(changed)) throw new Error("Invalid changed path input.")
  const result = planEvidence({ changed, capabilities: registry.capabilities, scenarios: registry.scenarios })
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, canonicalJson(result))
  await githubOutput("visual", String(result.scenarios.length > 0))
  await githubOutput("scenarios", JSON.stringify(result.scenarios.map(scenario => scenario.id)))
  process.stdout.write(canonicalJson(result))
}

async function toolchain() {
  const manifest = parseToolchainManifest(JSON.parse(await readFile(resolve(root, "tools/pr-evidence/ffmpeg.json"), "utf8")))
  const directory = resolve(root, options.output ?? `.cache/pr-evidence/ffmpeg/${manifest.ffmpegVersion}`)
  const installed = await installToolchain({ manifest, platform: `${process.platform}-${process.arch}`, directory, download })
  const output = resolve(root, "outputs/pr-evidence/toolchain.json")
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, canonicalJson(installed))
  await githubOutput("ffmpeg", installed.ffmpeg)
  await githubOutput("ffprobe", installed.ffprobe)
  process.stdout.write(canonicalJson(installed))
}

async function collect() {
  const planPath = resolve(root, options.plan ?? "outputs/pr-evidence/plan.json")
  const plan = JSON.parse(await readFile(planPath, "utf8"))
  const manifest = await collectEvidenceArtifact({
    plan,
    identity: {
      repositoryId: positive(required(options, "repository-id"), "repository id"),
      repository: required(options, "repository"),
      pullRequest: positive(required(options, "pull-request"), "pull request"),
      baseSha: required(options, "base"),
      headSha: required(options, "head"),
      runId: positive(required(options, "run-id"), "run id"),
      runAttempt: positive(required(options, "run-attempt"), "run attempt"),
    },
    captures: resolve(root, options.captures ?? "outputs/pr-evidence/local"),
    artifact: resolve(root, options.output ?? "outputs/pr-evidence/artifact"),
    ffmpeg: options.ffmpeg ?? "ffmpeg",
    ffprobe: options.ffprobe ?? "ffprobe",
    run: createProcessRunner({ timeoutMs: 60_000, maxOutputBytes: 2 * 1024 * 1024 }),
  })
  process.stdout.write(canonicalJson(manifest))
}

async function readRegistry() {
  return parseEvidenceRegistry(JSON.parse(await readFile(resolve(root, "tests/pr-evidence/registry.json"), "utf8")))
}

async function download(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`Tool download returned ${response.status}.`)
  return new Uint8Array(await response.arrayBuffer())
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

async function githubOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
}
