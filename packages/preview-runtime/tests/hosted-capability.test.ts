import { describe, expect, it } from "vitest"

import { issueHostedPreviewCapability, verifyHostedPreviewCapability } from "../src/hosted-capability.js"

const artifactId = "00000000-0000-4000-8000-000000000501"
const secret = "hosted-preview-capability-test-secret-at-least-32-bytes"
const audience = "https://preview.canvas.test"
const nonce = "00000000-0000-4000-8000-000000000601"

describe("hosted preview capability", () => {
  it("COMP-V2-CODE-006 binds a short-lived grant to one artifact and preview origin", async () => {
    const token = await issueHostedPreviewCapability({ artifactId, audience, secret, now: 1_800_000_000, lifetimeSeconds: 120, nonce })
    await expect(verifyHostedPreviewCapability({ token, artifactId, audience, secret, now: 1_800_000_119 }))
      .resolves.toMatchObject({ artifactId, audience, expiresAt: 1_800_000_120, nonce })
    await expect(verifyHostedPreviewCapability({ token, artifactId, audience, secret, now: 1_800_000_120 })).rejects.toThrow("invalid")
    await expect(verifyHostedPreviewCapability({ token, artifactId: "00000000-0000-4000-8000-000000000502", audience, secret, now: 1_800_000_001 })).rejects.toThrow("invalid")
    await expect(verifyHostedPreviewCapability({ token, artifactId, audience: "https://other.canvas.test", secret, now: 1_800_000_001 })).rejects.toThrow("invalid")
  })

  it("COMP-V2-CODE-006 rejects tampering, weak secrets, excessive lifetimes, and future grants", async () => {
    const token = await issueHostedPreviewCapability({ artifactId, audience, secret, now: 1_800_000_000, nonce })
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`
    await expect(verifyHostedPreviewCapability({ token: tampered, artifactId, audience, secret, now: 1_800_000_001 })).rejects.toThrow("invalid")
    await expect(issueHostedPreviewCapability({ artifactId, audience, secret: "short", now: 1_800_000_000, nonce })).rejects.toThrow("invalid")
    await expect(issueHostedPreviewCapability({ artifactId, audience, secret, now: 1_800_000_000, lifetimeSeconds: 301, nonce })).rejects.toThrow("invalid")
    await expect(verifyHostedPreviewCapability({ token, artifactId, audience, secret, now: 1_799_999_900 })).rejects.toThrow("invalid")
  })

  it("COMP-V2-CODE-006 caps effective validity and rejects inverted timestamps", async () => {
    const futureToken = await issueHostedPreviewCapability({ artifactId, audience, secret, now: 1_800_000_030, lifetimeSeconds: 300, nonce })
    await expect(verifyHostedPreviewCapability({ token: futureToken, artifactId, audience, secret, now: 1_800_000_000 })).rejects.toThrow("invalid")

    const payload = {
      version: 1,
      artifactId,
      audience,
      issuedAt: 1_800_000_010,
      expiresAt: 1_800_000_010,
      nonce,
    }
    const encoded = btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded)))
    let binary = ""
    for (const byte of signature) binary += String.fromCharCode(byte)
    const signed = `${encoded}.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`
    await expect(verifyHostedPreviewCapability({ token: signed, artifactId, audience, secret, now: 1_800_000_000 })).rejects.toThrow("invalid")
  })
})
