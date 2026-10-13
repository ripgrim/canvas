---
name: pr-evidence
description: Plan and capture typed interaction evidence for a pull request. Use when preparing or updating a PR that changes observable editor behavior, automation contracts, evidence tooling, or UI workflows.
---

# PR evidence

Use the repository evidence pipeline for every relevant PR.

## Workflow

1. Build `@canvas/pr-evidence`.
2. Run the planner against the PR base and head.
3. Map every changed path to a capability.
4. Add the smallest real scenario for new behavior.
5. Keep actions in `@canvas/editor-automation`.
6. Capture the observable boundary through Playwright.
7. Assert live preview, HUD, and stored state independently.
8. Include a negative control for critical behavior.
9. Run `pnpm test:pr-evidence` locally.
10. Let the trusted workflow publish verified media.

Do not use fixed sleeps, internal store calls, synthetic screenshots, private upload endpoints, or desktop-wide capture. Keep FFmpeg in CI tooling. Never add it to the application package.

For nonvisual changes, add a narrow capability with a concrete reason. Do not label a behavior change nonvisual to bypass capture.

Generated evidence belongs under `outputs/pr-evidence`. Never commit generated media.
