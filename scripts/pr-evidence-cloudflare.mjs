import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { setTimeout as wait } from "node:timers/promises"

const root = resolve(import.meta.dirname, "..")
const bucket = "comp-canvas-pr-evidence"
const origin = "https://evidence.canvas.ripgrim.com"
const wranglerRoot = dirname(createRequire(import.meta.url).resolve("wrangler/package.json", { paths: [resolve(root, "apps/evidence-service")] }))
const wranglerPackage = JSON.parse(readFileSync(resolve(wranglerRoot, "package.json"), "utf8"))
const wranglerCli = resolve(wranglerRoot, wranglerPackage.bin.wrangler)

export function isMissingBucket(value) {
  return value.includes("The specified bucket does not exist") && value.includes("10006")
}

export async function reconcileEvidenceInfrastructure(apply) {
  let info = wrangler(["r2", "bucket", "info", bucket, "--json"], true)
  if (info.status !== 0) {
    if (!isMissingBucket(info.output)) throw new Error(`Evidence bucket inspection failed.\n${info.output}`)
    if (!apply) throw new Error("The PR evidence bucket does not exist.")
    wrangler(["r2", "bucket", "create", bucket])
    info = wrangler(["r2", "bucket", "info", bucket, "--json"])
  }
  if (apply) wrangler(["deploy"])
  await verifyOrigin(apply ? 6 : 1)
  return Object.freeze({ bucket, origin })
}

async function verifyOrigin(attempts) {
  let failure
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(origin, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(30_000) })
      if (response.status === 404) return
      failure = new Error(`Evidence service returned ${response.status}.`)
    } catch (error) {
      failure = error
    }
    if (attempt + 1 < attempts) await wait(2 ** attempt * 1_000)
  }
  throw new Error("Evidence service is not ready.", { cause: failure })
}

function wrangler(arguments_, allowFailure = false) {
  const result = spawnSync(process.execPath, [wranglerCli, ...arguments_], { cwd: resolve(root, "apps/evidence-service"), encoding: "utf8", maxBuffer: 2 * 1024 * 1024, shell: false, windowsHide: true })
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
  if (result.error) throw result.error
  if (!allowFailure && result.status !== 0) throw new Error(`Wrangler failed.\n${output}`)
  return Object.freeze({ status: result.status ?? -1, output })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argument = process.argv[2]
  if (argument && argument !== "--apply") throw new Error(`Unknown argument: ${argument}`)
  const result = await reconcileEvidenceInfrastructure(argument === "--apply")
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
