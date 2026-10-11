import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const harness = join(root, "scripts", "memory-harness.mjs");

test("CLOUD-SYNC-MEMORY-001 evidence reports absolute and delta RSS", () => {
  const result = spawnSync(
    process.execPath,
    [harness, "--mib", "1", "--max-rss-delta-mib", "256", "--max-absolute-rss-mib", "256"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.streamedMiB, 1);
  assert.equal(typeof report.peakRssMiB, "number");
  assert.equal(report.absoluteThresholdMiB, 256);
});

test("negative control: absolute RSS threshold fails independently", () => {
  const result = spawnSync(
    process.execPath,
    [harness, "--mib", "1", "--max-rss-delta-mib", "256", "--max-absolute-rss-mib", "1"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /absolute RSS exceeded/);
});
