import { appendFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"

export function selectEvidenceArtifact(value, name, maxBytes = 40 * 1024 * 1024) {
  if (!value || typeof value !== "object" || !Array.isArray(value.artifacts)) throw new Error("Invalid GitHub artifact response.")
  const matches = value.artifacts.filter(artifact => artifact && typeof artifact === "object" && artifact.name === name && artifact.expired === false)
  if (matches.length !== 1) throw new Error("Expected one exact evidence artifact.")
  const artifact = matches[0]
  if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0 || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0 || artifact.size_in_bytes > maxBytes) throw new Error("Evidence artifact size is invalid.")
  return Object.freeze({ id: artifact.id, bytes: artifact.size_in_bytes })
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2))
  const repository = required(options, "repository")
  const runId = positive(required(options, "run-id"), "run id")
  const runAttempt = positive(required(options, "run-attempt"), "run attempt")
  const token = requiredEnvironment("GITHUB_TOKEN")
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`GitHub returned ${response.status}.`)
  const selected = selectEvidenceArtifact(await response.json(), `pr-evidence-${runId}-${runAttempt}`)
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `artifact-id=${selected.id}\n`)
  process.stdout.write(`${JSON.stringify(selected)}\n`)
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

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main()
