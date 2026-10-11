import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const manifestPath = path.join(repositoryRoot, "deploy", "cloudflare-r2.json")
const wranglerConfigPath = path.join(repositoryRoot, "apps", "workers", "wrangler.jsonc")
const workersRoot = path.join(repositoryRoot, "apps", "workers")
const wranglerExecutable = path.join(workersRoot, "node_modules", "wrangler", "bin", "wrangler.js")
const managedLifecycleRules = new Map([
  ["canvas-thumbnail-claims", "thumbnail-claims/"],
  ["canvas-thumbnail-quota", "thumbnail-quota/"],
])

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

function requireExactKeys(value, allowed, required, label) {
  const object = requireObject(value, label)
  for (const key of Object.keys(object)) if (!allowed.includes(key)) throw new Error(`${label} has unsupported property ${key}`)
  for (const key of required) if (!(key in object)) throw new Error(`${label} is missing ${key}`)
  return object
}

export function validateManifest(manifest) {
  requireExactKeys(manifest, ["$schema", "accountId", "binding", "environments", "privacy", "lifecycleRules"], ["accountId", "binding", "environments", "privacy", "lifecycleRules"], "Cloudflare manifest")
  if (manifest.$schema !== undefined && typeof manifest.$schema !== "string") throw new Error("Cloudflare manifest $schema must be a string")
  if (typeof manifest.accountId !== "string" || !/^[a-f0-9]{32}$/.test(manifest.accountId)) {
    throw new Error("Cloudflare manifest accountId must be a 32-character lowercase hex value")
  }
  if (typeof manifest.binding !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(manifest.binding)) {
    throw new Error("Cloudflare manifest binding must be an uppercase binding name")
  }
  requireExactKeys(manifest.environments, ["local", "preview", "production"], ["local", "preview", "production"], "Cloudflare environments")
  for (const environmentName of ["local", "preview", "production"]) {
    const environment = manifest.environments?.[environmentName]
    requireExactKeys(environment, ["mode", "workerState", "bucketName", "location", "storageClass", "apiOrigin", "allowedOrigins"], ["mode", "workerState", "bucketName", "apiOrigin", "allowedOrigins"], `Cloudflare ${environmentName} environment`)
    if (!environment || !["simulation", "remote"].includes(environment.mode)) {
      throw new Error(`Cloudflare manifest is missing environment ${environmentName}`)
    }
    if ((environmentName === "local" && environment.mode !== "simulation") || (environmentName !== "local" && environment.mode !== "remote")) {
      throw new Error(`Cloudflare ${environmentName} mode is invalid`)
    }
    if (!['disabled', 'deployed'].includes(environment.workerState) || (environmentName === 'local' && environment.workerState !== 'disabled') || (environmentName !== 'local' && environment.workerState !== 'deployed')) {
      throw new Error(`Cloudflare ${environmentName} Worker state is invalid`)
    }
    if (typeof environment.bucketName !== "string" || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(environment.bucketName)) {
      throw new Error(`Cloudflare ${environmentName} bucket name is invalid`)
    }
    if (environment.location !== undefined && !["weur", "eeur", "apac", "wnam", "enam", "oc"].includes(environment.location)) throw new Error(`Cloudflare ${environmentName} location is invalid`)
    if (environment.storageClass !== undefined && !["Standard", "InfrequentAccess"].includes(environment.storageClass)) throw new Error(`Cloudflare ${environmentName} storage class is invalid`)
    const origins = [environment.apiOrigin, ...(environment.allowedOrigins ?? [])]
    if (!Array.isArray(environment.allowedOrigins) || environment.allowedOrigins.length < 1 || new Set(environment.allowedOrigins).size !== environment.allowedOrigins.length || origins.some((origin) => {
      try {
        const url = new URL(origin)
        return environment.mode === "remote" ? url.protocol !== "https:" : !["http:", "https:"].includes(url.protocol)
      } catch {
        return true
      }
    })) {
      throw new Error(`Cloudflare ${environmentName} origins are invalid`)
    }
  }
  if (manifest.environments.preview.bucketName === manifest.environments.production.bucketName) {
    throw new Error("Cloudflare preview and production bucket names must differ")
  }
  requireExactKeys(manifest.privacy, ["r2DevUrl", "customDomains"], ["r2DevUrl", "customDomains"], "Cloudflare privacy")
  if (manifest.privacy?.r2DevUrl !== false || !Array.isArray(manifest.privacy?.customDomains) || manifest.privacy.customDomains.length !== 0) {
    throw new Error("Cloudflare R2 buckets must remain private")
  }
  if (!Array.isArray(manifest.lifecycleRules) || manifest.lifecycleRules.length !== managedLifecycleRules.size) {
    throw new Error("Cloudflare lifecycle rules must contain only the managed marker rules")
  }
  const names = new Set()
  for (const rule of manifest.lifecycleRules) {
    requireExactKeys(rule, ["name", "prefix", "expireDays"], ["name", "prefix", "expireDays"], "Cloudflare lifecycle rule")
    if (!rule.name || names.has(rule.name) || !rule.prefix || !Number.isInteger(rule.expireDays) || rule.expireDays < 1) {
      throw new Error("Cloudflare lifecycle rules must have unique names, prefixes, and positive whole-day expirations")
    }
    if (managedLifecycleRules.get(rule.name) !== rule.prefix) throw new Error("Cloudflare lifecycle rules must use the exact managed marker prefixes")
    names.add(rule.name)
  }
  return manifest
}

export function validateWranglerConfig(config, manifest) {
  const rootBinding = config.r2_buckets?.find((entry) => entry.binding === manifest.binding)
  const previewBinding = config.env?.preview?.r2_buckets?.find((entry) => entry.binding === manifest.binding)
  const productionBinding = config.env?.production?.r2_buckets?.find((entry) => entry.binding === manifest.binding)
  const expected = [
    ["local", rootBinding, false],
    ["preview", previewBinding, true],
    ["production", productionBinding, false],
  ]
  for (const [environmentName, binding, expectedRemote] of expected) {
    const environment = manifest.environments[environmentName]
    if (binding?.bucket_name !== manifest.environments[environmentName].bucketName) {
      throw new Error(`Wrangler ${environmentName} R2 binding does not match the Cloudflare manifest`)
    }
    if (Boolean(binding.remote) !== expectedRemote) {
      throw new Error(`Wrangler ${environmentName} R2 remote mode is incorrect`)
    }
    if (environmentName === "local" && binding.preview_bucket_name !== manifest.environments.preview.bucketName) {
      throw new Error("Wrangler preview bucket name does not match the Cloudflare manifest")
    }
    const variables = environmentName === "local" ? config.vars : config.env?.[environmentName]?.vars
    if (variables?.API_ORIGIN !== environment.apiOrigin) {
      throw new Error(`Wrangler ${environmentName} API origin does not match the Cloudflare manifest`)
    }
    if (variables?.ALLOWED_ORIGINS !== environment.allowedOrigins.join(",")) {
      throw new Error(`Wrangler ${environmentName} allowed origins do not match the Cloudflare manifest`)
    }
  }
}

export function parseAccountId(output) {
  const match = output.match(/\b[a-f0-9]{32}\b/)
  return match?.[0] ?? null
}

export function parseLifecycleRules(output) {
  const rules = []
  for (const block of output.split(/\r?\n\s*\r?\n/)) {
    const name = block.match(/^name:\s+(.+)$/m)?.[1]?.trim()
    const enabled = block.match(/^enabled:\s+(.+)$/m)?.[1]?.trim().toLowerCase() === "yes"
    const prefix = block.match(/^prefix:\s+(.+)$/m)?.[1]?.trim()
    const expireDays = Number(block.match(/^action:\s+Expire objects after (\d+) days?$/m)?.[1])
    if (name && prefix && Number.isInteger(expireDays) && expireDays > 0) {
      rules.push({ name, prefix, expireDays, enabled })
    }
  }
  return rules
}

export function lifecycleRuleMatches(actual, expected) {
  return actual?.enabled === true && actual.name === expected.name && actual.prefix === expected.prefix && actual.expireDays === expected.expireDays
}

export function isMissingBucket(output) {
  return output.includes("The specified bucket does not exist") && output.includes("[code: 10006]")
}

export function isMissingWorker(output) {
  return output.includes("[code: 10007]") || /worker.*(?:does not exist|not found)/i.test(output)
}

export function parseDeploymentCount(output) {
  const parsed = JSON.parse(output)
  const deployments = Array.isArray(parsed) ? parsed : parsed?.deployments
  if (!Array.isArray(deployments)) throw new Error("Wrangler deployment output is invalid")
  return deployments.length
}

export function assertEmptyBucket(info) {
  const count = info?.object_count
  const valid = (typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
    || (typeof count === "string" && /^(?:0|[1-9]\d*)$/.test(count))
  if (!valid) throw new Error("R2 bucket object count is ambiguous")
  if (Number(count) !== 0) throw new Error(`R2 bucket ${info?.name ?? "unknown"} must be empty before release setup`)
}

export function assertExactLifecycleRules(actualRules, expectedRules) {
  for (const expectedRule of expectedRules) {
    if (!lifecycleRuleMatches(actualRules.find((rule) => rule.name === expectedRule.name), expectedRule)) {
      throw new Error(`R2 lifecycle rule ${expectedRule.name} failed verification`)
    }
  }
  if (actualRules.length !== expectedRules.length) throw new Error("R2 has unexpected object-expiration lifecycle rules")
}

export function assertWorkerDeployment(result, expectedState) {
  if (!['disabled', 'deployed'].includes(expectedState)) throw new Error('Worker deployment expectation is invalid')
  if (result.status === 0) {
    const deployed = parseDeploymentCount(result.output) > 0
    if (expectedState === 'deployed' && !deployed) throw new Error('Cloudflare Worker is not deployed')
    if (expectedState === 'disabled' && deployed) throw new Error('Cloudflare Worker must not be deployed')
    return deployed
  }
  if (!isMissingWorker(result.output)) throw new Error(`Worker deployment inspection failed without a confirmed not-found response\n${result.output}`)
  if (expectedState === 'deployed') throw new Error('Cloudflare Worker is not deployed')
  return false
}

function lifecycleAddArguments(bucketName, rule, name = rule.name) {
  return ["r2", "bucket", "lifecycle", "add", bucketName, name, rule.prefix, "--expire-days", String(rule.expireDays), "--force"]
}

function runWrangler(args, { allowFailure = false } = {}) {
  const result = spawnSync(
    process.execPath,
    [wranglerExecutable, ...args],
    {
      cwd: workersRoot,
      encoding: "utf8",
      windowsHide: true,
    },
  )
  if (result.error) throw result.error
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`Wrangler command failed: wrangler ${args.join(" ")}\n${output}`)
  }
  return { status: result.status ?? 1, output }
}

function reconcileLifecycleRule(bucketName, actualRule, expectedRule) {
  if (!actualRule) {
    runWrangler(lifecycleAddArguments(bucketName, expectedRule))
    return
  }
  const backupName = `${expectedRule.name}-replacement-${Date.now()}`
  runWrangler(lifecycleAddArguments(bucketName, expectedRule, backupName))
  runWrangler(["r2", "bucket", "lifecycle", "remove", bucketName, "--name", expectedRule.name, "--force"])
  try {
    runWrangler(lifecycleAddArguments(bucketName, expectedRule))
  } catch (error) {
    try { runWrangler(lifecycleAddArguments(bucketName, actualRule)) }
    catch (restoreError) { throw new AggregateError([error, restoreError], "The lifecycle update and rollback both failed.") }
    throw error
  }
  runWrangler(["r2", "bucket", "lifecycle", "remove", bucketName, "--name", backupName, "--force"])
}

async function loadConfiguration() {
  const [manifestSource, wranglerSource] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(wranglerConfigPath, "utf8"),
  ])
  const manifest = validateManifest(JSON.parse(manifestSource))
  validateWranglerConfig(JSON.parse(wranglerSource), manifest)
  return manifest
}

function readArguments(argv) {
  const environmentIndex = argv.indexOf("--environment")
  const environment = environmentIndex === -1 ? "preview" : argv[environmentIndex + 1]
  if (!environment || !["local", "preview", "production"].includes(environment)) {
    throw new Error("--environment must be local, preview, or production")
  }
  return { apply: argv.includes("--apply"), environment }
}

async function main() {
  const { apply, environment } = readArguments(process.argv.slice(2))
  const manifest = await loadConfiguration()
  const resource = manifest.environments[environment]

  if (resource.mode === "simulation") {
    console.log(`CLOUDFLARE_R2_EVIDENCE ${JSON.stringify({ environment, mode: resource.mode, bucketName: resource.bucketName })}`)
    return
  }

  const whoami = runWrangler(["whoami"])
  const accountId = parseAccountId(whoami.output)
  if (accountId !== manifest.accountId) {
    throw new Error(`Wrangler is authenticated to account ${accountId ?? "unknown"}, expected ${manifest.accountId}`)
  }

  let infoResult = runWrangler(["r2", "bucket", "info", resource.bucketName, "--json"], { allowFailure: true })
  if (infoResult.status !== 0) {
    if (!isMissingBucket(infoResult.output)) {
      throw new Error(`R2 bucket inspection failed without a confirmed not-found response\n${infoResult.output}`)
    }
    if (!apply) throw new Error(`R2 bucket ${resource.bucketName} does not exist; run pnpm cloudflare:setup`)
    const createArguments = ["r2", "bucket", "create", resource.bucketName]
    if (resource.location) createArguments.push("--location", resource.location)
    if (resource.storageClass) createArguments.push("--storage-class", resource.storageClass)
    runWrangler(createArguments)
    infoResult = runWrangler(["r2", "bucket", "info", resource.bucketName, "--json"])
  }

  const info = JSON.parse(infoResult.output)
  if (info.name !== resource.bucketName) throw new Error("Wrangler returned the wrong R2 bucket")
  if (resource.location && info.location?.toLowerCase() !== resource.location) {
    throw new Error(`R2 bucket location is ${info.location}, expected ${resource.location.toUpperCase()}`)
  }
  if (resource.storageClass && info.default_storage_class !== resource.storageClass) {
    throw new Error(`R2 bucket storage class is ${info.default_storage_class}, expected ${resource.storageClass}`)
  }
  if (resource.workerState === 'disabled') assertEmptyBucket(info)

  let devUrl = runWrangler(["r2", "bucket", "dev-url", "get", resource.bucketName]).output
  if (!devUrl.includes("r2.dev URL is disabled")) {
    if (!apply) throw new Error(`R2 bucket ${resource.bucketName} has public r2.dev access enabled`)
    runWrangler(["r2", "bucket", "dev-url", "disable", resource.bucketName, "--force"])
    devUrl = runWrangler(["r2", "bucket", "dev-url", "get", resource.bucketName]).output
    if (!devUrl.includes("r2.dev URL is disabled")) throw new Error("R2 public access could not be disabled")
  }

  const domains = runWrangler(["r2", "bucket", "domain", "list", resource.bucketName]).output
  if (!domains.includes("There are no custom domains connected to this bucket")) {
    throw new Error(`R2 bucket ${resource.bucketName} has a custom domain; remove it before continuing`)
  }

  let lifecycleOutput = runWrangler(["r2", "bucket", "lifecycle", "list", resource.bucketName]).output
  let lifecycleRules = parseLifecycleRules(lifecycleOutput)
  for (const expectedRule of manifest.lifecycleRules) {
    const actualRule = lifecycleRules.find((rule) => rule.name === expectedRule.name)
    if (lifecycleRuleMatches(actualRule, expectedRule)) continue
    if (!apply) throw new Error(`R2 lifecycle rule ${expectedRule.name} is missing or does not match the manifest`)
    reconcileLifecycleRule(resource.bucketName, actualRule, expectedRule)
  }

  lifecycleOutput = runWrangler(["r2", "bucket", "lifecycle", "list", resource.bucketName]).output
  lifecycleRules = parseLifecycleRules(lifecycleOutput)
  assertExactLifecycleRules(lifecycleRules, manifest.lifecycleRules)

  const deploymentArguments = ["deployments", "list", "--env", environment, "--json"]
  const deployedWorker = assertWorkerDeployment(runWrangler(deploymentArguments, { allowFailure: true }), resource.workerState)

  console.log(`CLOUDFLARE_R2_EVIDENCE ${JSON.stringify({
    accountId,
    environment,
    bucketName: info.name,
    location: info.location,
    storageClass: info.default_storage_class,
    objectCount: info.object_count,
    workerState: resource.workerState,
    r2DevUrl: false,
    customDomains: [],
    lifecycleRules: manifest.lifecycleRules,
    deployedWorker,
  })}`)
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ""
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
