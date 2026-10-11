import assert from "node:assert/strict"
import test from "node:test"

import {
  assertEmptyBucket,
  assertExactLifecycleRules,
  assertNoDeployedWorker,
  lifecycleRuleMatches,
  isMissingBucket,
  isMissingWorker,
  parseAccountId,
  parseDeploymentCount,
  parseLifecycleRules,
  validateManifest,
  validateWranglerConfig,
} from "./cloudflare-r2.mjs"

const manifest = {
  accountId: "8ff4938c32b292a31ca4e84cc383181b",
  binding: "FILE_ASSETS",
  environments: {
    local: {
      mode: "simulation",
      bucketName: "comp-canvas-file-assets-dev",
      apiOrigin: "http://127.0.0.1:4320",
      allowedOrigins: ["http://127.0.0.1:4317"],
    },
    preview: {
      mode: "remote",
      bucketName: "comp-canvas-file-assets-dev",
      apiOrigin: "https://api.canvas.ripgrim.com",
      allowedOrigins: ["https://canvas.ripgrim.com"],
    },
    production: {
      mode: "remote",
      bucketName: "comp-canvas-file-assets-production",
      apiOrigin: "https://api.canvas.ripgrim.com",
      allowedOrigins: ["https://canvas.ripgrim.com"],
    },
  },
  privacy: { r2DevUrl: false, customDomains: [] },
  lifecycleRules: [
    { name: "canvas-thumbnail-claims", prefix: "thumbnail-claims/", expireDays: 8 },
    { name: "canvas-thumbnail-quota", prefix: "thumbnail-quota/", expireDays: 1 },
  ],
}

test("accepts the private three-environment R2 manifest", () => {
  assert.equal(validateManifest(structuredClone(manifest)).binding, "FILE_ASSETS")
})

test("rejects a manifest that enables direct bucket access", () => {
  const publicManifest = structuredClone(manifest)
  publicManifest.privacy.r2DevUrl = true
  assert.throws(() => validateManifest(publicManifest), /must remain private/)
})

test("rejects preview and production bucket collisions", () => {
  const collided = structuredClone(manifest)
  collided.environments.production.bucketName = collided.environments.preview.bucketName
  assert.throws(() => validateManifest(collided), /must differ/)
})

test("rejects missing, broad, extra, and unknown lifecycle configuration", () => {
  const missing = structuredClone(manifest)
  delete missing.lifecycleRules
  assert.throws(() => validateManifest(missing), /missing lifecycleRules/)

  const broad = structuredClone(manifest)
  broad.lifecycleRules[0].prefix = "thumbnails/"
  assert.throws(() => validateManifest(broad), /exact managed marker prefixes/)

  const extra = structuredClone(manifest)
  extra.lifecycleRules[0].unexpected = true
  assert.throws(() => validateManifest(extra), /unsupported property unexpected/)

  const numericBucket = structuredClone(manifest)
  numericBucket.environments.preview.bucketName = 123
  assert.throws(() => validateManifest(numericBucket), /bucket name is invalid/)

  const numericSchema = structuredClone(manifest)
  numericSchema.$schema = 123
  assert.throws(() => validateManifest(numericSchema), /\$schema must be a string/)
})

test("rejects a Wrangler binding that can write the remote bucket in local mode", () => {
  const config = {
    r2_buckets: [{ binding: "FILE_ASSETS", bucket_name: "comp-canvas-file-assets-dev", preview_bucket_name: "comp-canvas-file-assets-dev", remote: true }],
    vars: { API_ORIGIN: "http://127.0.0.1:4320", ALLOWED_ORIGINS: "http://127.0.0.1:4317" },
    env: {
      preview: {
        r2_buckets: [{ binding: "FILE_ASSETS", bucket_name: "comp-canvas-file-assets-dev", remote: true }],
        vars: { API_ORIGIN: "https://api.canvas.ripgrim.com", ALLOWED_ORIGINS: "https://canvas.ripgrim.com" },
      },
      production: {
        r2_buckets: [{ binding: "FILE_ASSETS", bucket_name: "comp-canvas-file-assets-production" }],
        vars: { API_ORIGIN: "https://api.canvas.ripgrim.com", ALLOWED_ORIGINS: "https://canvas.ripgrim.com" },
      },
    },
  }
  assert.throws(() => validateWranglerConfig(config, manifest), /local R2 remote mode is incorrect/)
})

test("accepts isolated local, preview, and production bindings", () => {
  const config = {
    r2_buckets: [{ binding: "FILE_ASSETS", bucket_name: "comp-canvas-file-assets-dev", preview_bucket_name: "comp-canvas-file-assets-dev" }],
    vars: { API_ORIGIN: "http://127.0.0.1:4320", ALLOWED_ORIGINS: "http://127.0.0.1:4317" },
    env: {
      preview: {
        r2_buckets: [{ binding: "FILE_ASSETS", bucket_name: "comp-canvas-file-assets-dev", remote: true }],
        vars: { API_ORIGIN: "https://api.canvas.ripgrim.com", ALLOWED_ORIGINS: "https://canvas.ripgrim.com" },
      },
      production: {
        r2_buckets: [{ binding: "FILE_ASSETS", bucket_name: "comp-canvas-file-assets-production" }],
        vars: { API_ORIGIN: "https://api.canvas.ripgrim.com", ALLOWED_ORIGINS: "https://canvas.ripgrim.com" },
      },
    },
  }
  assert.doesNotThrow(() => validateWranglerConfig(config, manifest))
})

test("extracts only the authenticated Cloudflare account id", () => {
  const output = "Account ID\n8ff4938c32b292a31ca4e84cc383181b\nworkers (write)"
  assert.equal(parseAccountId(output), manifest.accountId)
  assert.equal(parseAccountId("not signed in"), null)
})

test("creates only after Cloudflare returns the exact missing-bucket response", () => {
  assert.equal(isMissingBucket("The specified bucket does not exist. [code: 10006]"), true)
  assert.equal(isMissingBucket("Authentication error [code: 10000]"), false)
})

test("parses managed expiration rules and ignores the default multipart rule", () => {
  const output = `name:     Default Multipart Abort Rule
enabled:  Yes
prefix:   (all prefixes)
action:   Abort incomplete multipart uploads after 7 days

name:     canvas-thumbnail-claims
enabled:  Yes
prefix:   thumbnail-claims/
action:   Expire objects after 8 days`
  assert.deepEqual(parseLifecycleRules(output), [
    { name: "canvas-thumbnail-claims", prefix: "thumbnail-claims/", expireDays: 8, enabled: true },
  ])
  assert.equal(lifecycleRuleMatches(parseLifecycleRules(output)[0], manifest.lifecycleRules[0]), true)
})

test("does not accept a disabled lifecycle rule as managed protection", () => {
  const output = `name:     canvas-thumbnail-claims
enabled:  No
prefix:   thumbnail-claims/
action:   Expire objects after 8 days`
  assert.equal(lifecycleRuleMatches(parseLifecycleRules(output)[0], manifest.lifecycleRules[0]), false)
})

test("parses Worker deployment evidence and only accepts exact not-found failures", () => {
  assert.equal(parseDeploymentCount("[]"), 0)
  assert.equal(parseDeploymentCount(JSON.stringify({ deployments: [{ id: "one" }] })), 1)
  assert.throws(() => parseDeploymentCount("{}"), /invalid/)
  assert.equal(isMissingWorker("Worker does not exist [code: 10007]"), true)
  assert.equal(isMissingWorker("Authentication error [code: 10000]"), false)
  assert.equal(assertNoDeployedWorker({ status: 1, output: "Worker does not exist [code: 10007]" }), false)
  assert.throws(() => assertNoDeployedWorker({ status: 0, output: JSON.stringify([{ id: "deployed" }]) }), /already deployed/)
  assert.throws(() => assertNoDeployedWorker({ status: 1, output: "Authentication error [code: 10000]" }), /confirmed not-found/)
})

test("rejects non-empty buckets and lifecycle drift", () => {
  assert.doesNotThrow(() => assertEmptyBucket({ name: "preview", object_count: "0" }))
  assert.throws(() => assertEmptyBucket({ name: "preview", object_count: "1" }), /must be empty/)
  assert.throws(() => assertEmptyBucket({ name: "preview", object_count: null }), /ambiguous/)
  assert.throws(() => assertEmptyBucket({ name: "preview", object_count: "" }), /ambiguous/)

  const exact = manifest.lifecycleRules.map(rule => ({ ...rule, enabled: true }))
  assert.doesNotThrow(() => assertExactLifecycleRules(exact, manifest.lifecycleRules))
  assert.throws(() => assertExactLifecycleRules([...exact, { name: "extra", prefix: "extra/", expireDays: 1, enabled: true }], manifest.lifecycleRules), /unexpected/)
  assert.throws(() => assertExactLifecycleRules(exact.map((rule, index) => index === 0 ? { ...rule, enabled: false } : rule), manifest.lifecycleRules), /failed verification/)
})
