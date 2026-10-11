import { createHash } from "node:crypto";

function readNumber(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${flag} must be a positive number.`);
  }
  return value;
}

const targetMiB = readNumber("--mib", 50);
const maxRssDeltaMiB = readNumber("--max-rss-delta-mib", 64);
const maxAbsoluteRssMiB = readNumber("--max-absolute-rss-mib", 256);
const totalBytes = Math.floor(targetMiB * 1024 * 1024);
const chunkBytes = 64 * 1024;
const baselineRss = process.memoryUsage().rss;
let peakRss = baselineRss;
let streamedBytes = 0;
const hash = createHash("sha256");

while (streamedBytes < totalBytes) {
  const size = Math.min(chunkBytes, totalBytes - streamedBytes);
  const chunk = Buffer.allocUnsafe(size);
  chunk.fill(streamedBytes % 251);
  hash.update(chunk);
  streamedBytes += size;
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}

const rssDeltaMiB = (peakRss - baselineRss) / 1024 / 1024;
const result = {
  digest: hash.digest("hex"),
  mode: "synthetic-stream-only",
  peakRssMiB: Number((peakRss / 1024 / 1024).toFixed(2)),
  rssDeltaMiB: Number(rssDeltaMiB.toFixed(2)),
  streamedMiB: Number((streamedBytes / 1024 / 1024).toFixed(2)),
  thresholdMiB: maxRssDeltaMiB,
  absoluteThresholdMiB: maxAbsoluteRssMiB,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

if (rssDeltaMiB > maxRssDeltaMiB) {
  process.stderr.write("Streaming RSS delta exceeded the configured threshold.\n");
  process.exitCode = 1;
}
if (peakRss / 1024 / 1024 > maxAbsoluteRssMiB) {
  process.stderr.write("Streaming absolute RSS exceeded the configured threshold.\n");
  process.exitCode = 1;
}
