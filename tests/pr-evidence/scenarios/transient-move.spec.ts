import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createPlaywrightAutomation } from "@canvas/editor-automation/playwright"
import { expect, test, type Page } from "@playwright/test"

const editorUrl = "http://127.0.0.1:4327/"
const evidenceRoot = resolve(import.meta.dirname, "../../../outputs/pr-evidence/local/editor.transient-move/browser")

test("PR-EVIDENCE-003 [editor.transient-move]", async ({ page }) => {
  await mkdir(evidenceRoot, { recursive: true })
  const frameTimes: number[] = []
  let recording = false
  const automation = createPlaywrightAutomation({
    page,
    evidence: {
      async screenshot(name, target) {
        await target.screenshot({ path: join(evidenceRoot, `${name}.png`), animations: "disabled", caret: "hide" })
      },
      async record(target, run) {
        const path = join(evidenceRoot, "raw.webm")
        recording = true
        await target.screencast.start({
          path,
          size: { width: 1500, height: 940 },
          onFrame: frame => frameTimes.push(frame.timestamp),
        })
        try {
          return await run()
        } finally {
          await target.screencast.stop()
          recording = false
        }
      },
    },
  })

  await page.goto(editorUrl, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: /New file/i }).first().click()
  await page.locator(".canvas-stage").waitFor()
  await page.frameLocator('iframe[title="Canvas"]').locator("#preview-root").waitFor({ state: "attached" })
  const stage = await requiredBox(page.locator(".canvas-stage").boundingBox(), "canvas stage")
  const viewport = await page.locator(".canvas-viewport").evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }))
  const camera = await readCamera(page)
  const screen = (point: { x: number; y: number }) => ({ x: stage.x + viewport.width / 2 + camera.x + point.x * camera.zoom, y: stage.y + viewport.height / 2 + camera.y + point.y * camera.zoom })
  const from = screen({ x: -120, y: -80 })
  const to = screen({ x: 120, y: 40 })
  await page.keyboard.press("r")
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()

  const node = await automation.layers.named("Rectangle")
  await node.expectKind("rectangle")
  const before = await node.resolve()
  const beforeFile = await storedFile(page)
  const beforeViewport = await requiredBox(page.locator(".canvas-viewport").boundingBox(), "canvas viewport")
  const delta = { x: 84, y: 52 }
  await automation.evidence.screenshot("before")

  await automation.evidence.record(async () => {
    await automation.mouse.drag(node.center(), node.center().offset(delta.x, delta.y), {
      steps: 10,
      whileHeld: async () => {
        const preview = previewNode(page, node.id)
        await expect.poll(() => preview.evaluate(element => (element as HTMLElement).style.translate)).not.toBe("")
        const held = await requiredBox(preview.boundingBox(), "held node")
        expect(Math.abs(held.x - before.bounds.x - delta.x)).toBeLessThanOrEqual(1.5)
        expect(Math.abs(held.y - before.bounds.y - delta.y)).toBeLessThanOrEqual(1.5)
        const hud = await readHud(page)
        const selected = hud.selected[node.id]
        expect(selected).toBeTruthy()
        const hudBox = await requiredBox(page.locator(".canvas-hud-canvas").boundingBox(), "canvas HUD")
        expect(Math.abs(hudBox.x + selected.x - held.x)).toBeLessThanOrEqual(1.5)
        expect(Math.abs(hudBox.y + selected.y - held.y)).toBeLessThanOrEqual(1.5)
        expect(selected.width).toBeCloseTo(held.width, 1)
        expect(selected.height).toBeCloseTo(held.height, 1)
        expect((await storedFile(page)).nodes[node.id].styles).toEqual(beforeFile.nodes[node.id].styles)
        expect(await page.locator(".canvas-viewport").boundingBox()).toEqual(beforeViewport)
        await automation.evidence.screenshot("held")
      },
    })
  })

  const preview = previewNode(page, node.id)
  await expect.poll(() => preview.evaluate(element => (element as HTMLElement).style.translate)).toBe("")
  const placed = await requiredBox(preview.boundingBox(), "placed node")
  expect(placed.x).toBeCloseTo(before.bounds.x + delta.x, 1)
  expect(placed.y).toBeCloseTo(before.bounds.y + delta.y, 1)
  expect((await storedFile(page)).nodes[node.id].styles).not.toEqual(beforeFile.nodes[node.id].styles)
  expect(await page.locator(".canvas-viewport").boundingBox()).toEqual(beforeViewport)
  await automation.evidence.screenshot("after")
  expect(recording).toBe(false)
  expect(frameTimes.length).toBeGreaterThan(0)
  expect(frameTimes.every((value, index) => index === 0 || value >= frameTimes[index - 1]!)).toBe(true)
  const raw = await readFile(join(evidenceRoot, "raw.webm"))
  expect(raw.byteLength).toBeGreaterThan(0)
  await writeFile(join(evidenceRoot, "capture.json"), `${JSON.stringify({
    sourceFrames: frameTimes.length,
    durationMs: frameTimes.length > 1 ? frameTimes.at(-1)! - frameTimes[0]! : 0,
    sha256: createHash("sha256").update(raw).digest("hex"),
  }, null, 2)}\n`)
})

function previewNode(page: Page, id: string) {
  return page.frameLocator('iframe[title="Canvas"]').locator(`[data-preview-canvas="${id}"]`)
}

async function requiredBox(input: Promise<{ x: number; y: number; width: number; height: number } | null>, label: string) {
  const box = await input
  if (!box) throw new Error(`${label} has no bounds.`)
  return box
}

async function readCamera(page: Page) {
  return page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(".canvas-world")
    const match = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/u.exec(element?.style.transform ?? "")
    if (!match) throw new Error("Canvas camera is unavailable.")
    return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) }
  })
}

async function readHud(page: Page): Promise<{ selected: Record<string, { x: number; y: number; width: number; height: number }> }> {
  return page.locator(".canvas-hud-canvas").evaluate(canvas => JSON.parse((canvas as HTMLElement).dataset.hud ?? '{"selected":{}}'))
}

async function storedFile(page: Page): Promise<{ nodes: Record<string, { styles: unknown }> }> {
  const id = decodeURIComponent(new URL(page.url()).pathname.split("/").pop() ?? "")
  return page.evaluate(fileId => {
    const raw = localStorage.getItem(`design-editor.browser-file.${fileId}.v3`)
    if (!raw) throw new Error("Stored file is unavailable.")
    return JSON.parse(raw).file
  }, id)
}
