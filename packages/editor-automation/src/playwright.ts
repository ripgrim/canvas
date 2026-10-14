import type { Page } from "@playwright/test"
import {
  AutomationError,
  boundsTarget,
  type EvidenceApi,
  type EditorAutomation,
  type GeometryTarget,
  type KeyboardApi,
  type LayersApi,
  type ModifierKey,
  type MouseApi,
  type NodeId,
  type NodeKind,
  type NodeOverlaySnapshot,
  type NodeRef,
  type NodeSnapshot,
  type CaptureCrop,
  type RecordingOptions,
  type ResolvedScreenshotOptions,
  type ResolvedRecordingOptions,
  type ResizeHandle,
  type RotationHandle,
  type ScreenshotOptions,
} from "./index.js"

export type PlaywrightEvidencePort<CheckpointName extends string> = Readonly<{
  screenshot(name: CheckpointName, page: Page, options: ResolvedScreenshotOptions): Promise<void>
  record<Result>(page: Page, options: ResolvedRecordingOptions, run: () => Promise<Result>): Promise<Result>
}>

export function createPlaywrightAutomation<CheckpointName extends string>(options: Readonly<{
  page: Page
  evidence: PlaywrightEvidencePort<CheckpointName>
}>): EditorAutomation<CheckpointName> {
  const { page } = options

  const ref = <Kind extends NodeKind = NodeKind>(id: NodeId): NodeRef<Kind> => {
    const resolve = async (): Promise<NodeSnapshot<Kind>> => {
      const layer = page.locator(`[data-instance-id="${escapeAttribute(id)}"]`)
      if (await layer.count() !== 1) throw new AutomationError("target-not-found", `Node ${id} is unavailable.`)
      const preview = page.frameLocator('iframe[title="Canvas"]').locator(`[data-preview-instance="${escapeAttribute(id)}"], [data-preview-canvas="${escapeAttribute(id)}"]`)
      if (await preview.count() !== 1) throw new AutomationError("target-not-found", `Preview node ${id} is unavailable.`)
      const box = await preview.boundingBox()
      if (!box) throw new AutomationError("target-not-found", `Preview node ${id} has no bounds.`)
      const kind = await layer.getAttribute("data-node-kind")
      const name = (await layer.getAttribute("aria-label")) ?? (await layer.textContent())?.trim() ?? ""
      if (!isNodeKind(kind)) throw new AutomationError("unsupported-capability", `Node ${id} has no supported kind.`)
      return Object.freeze({ id, kind: kind as Kind, name, bounds: Object.freeze(box) })
    }
    const bounds = () => boundsTarget(async () => (await resolve()).bounds)
    const overlay = async (): Promise<NodeOverlaySnapshot> => {
      const canvas = page.locator(".canvas-hud-canvas")
      const canvasBox = await canvas.boundingBox()
      if (!canvasBox) throw new AutomationError("stale-projection", `Node ${id} has no HUD projection.`)
      const selected = await canvas.evaluate((element, node) => {
        const hud = JSON.parse((element as HTMLElement).dataset.hud ?? '{"selected":{}}') as {
          selected?: Record<string, { x: number; y: number; width: number; height: number }>
        }
        return hud.selected?.[node] ?? null
      }, id)
      if (!selected) throw new AutomationError("stale-projection", `Node ${id} has no HUD projection.`)
      const resizeHandles = await page.locator(`[data-handles-for="${escapeAttribute(id)}"] [data-handle]`).evaluateAll(elements => elements.map(element => element.getAttribute("data-handle")))
      const rotationHandles = await page.locator(`[data-rotation-handles-for="${escapeAttribute(id)}"] [data-rotation-handle]`).evaluateAll(elements => elements.map(element => element.getAttribute("data-rotation-handle")))
      return Object.freeze({
        bounds: Object.freeze({ x: canvasBox.x + selected.x, y: canvasBox.y + selected.y, width: selected.width, height: selected.height }),
        resizeHandles: Object.freeze(resizeHandles.filter(isResizeHandle)),
        rotationHandles: Object.freeze(rotationHandles.filter(isRotationHandle)),
      })
    }
    return Object.freeze({
      id,
      resolve,
      bounds,
      center: () => bounds().center(),
      overlay,
      expectKind: async <Next extends Kind>(kind: Next) => {
        const snapshot = await resolve()
        if (snapshot.kind !== kind) throw new AutomationError("unsupported-capability", `Node ${id} is ${snapshot.kind}, not ${kind}.`)
        return ref<Next>(id)
      },
    })
  }

  const mouse: MouseApi = Object.freeze({
    click: async (target: GeometryTarget) => {
      const point = await target.resolve()
      await page.mouse.click(point.x, point.y)
    },
    move: async (target: GeometryTarget) => {
      const point = await target.resolve()
      await page.mouse.move(point.x, point.y)
    },
    drag: async (from: GeometryTarget, to: GeometryTarget, input: Readonly<{
      modifiers?: readonly ModifierKey[]
      steps?: number
      whileHeld?: () => Promise<void>
    }> = {}) => {
      const modifiers = input.modifiers ?? []
      let pressed = false
      try {
        for (const modifier of modifiers) await page.keyboard.down(modifier)
        const start = await from.resolve()
        await page.mouse.move(start.x, start.y)
        await page.mouse.down()
        pressed = true
        const end = await to.resolve()
        await page.mouse.move(end.x, end.y, { steps: input.steps ?? 8 })
        await input.whileHeld?.()
      } finally {
        if (pressed) await page.mouse.up().catch(() => undefined)
        for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier).catch(() => undefined)
      }
    },
  })

  const keyboard: KeyboardApi = Object.freeze({
    press: (key: string) => page.keyboard.press(key),
    chord: (keys: readonly string[]) => page.keyboard.press(keys.join("+")),
    type: (text: string) => page.keyboard.type(text),
  })

  const layers: LayersApi = Object.freeze({
    node: (id: NodeId) => ref(id),
    named: async (name: string) => {
      const matches = page.getByRole("tree", { name: "Layers" }).getByRole("treeitem", { name, exact: true })
      const count = await matches.count()
      if (count !== 1) throw new AutomationError(count ? "target-ambiguous" : "target-not-found", `Expected one layer named ${name}.`, { count })
      const id = await matches.getAttribute("data-instance-id")
      if (!id) throw new AutomationError("target-not-found", `Layer ${name} has no node id.`)
      return ref(id as NodeId)
    },
    selected: async () => {
      const ids = await page.locator('[data-instance-id][aria-selected="true"]').evaluateAll(elements => elements.map(element => element.getAttribute("data-instance-id")))
      return Object.freeze(ids.filter((id): id is string => Boolean(id)).map(id => ref(id as NodeId)))
    },
  })

  const evidence: EvidenceApi<CheckpointName> = Object.freeze({
    screenshot: async (name: CheckpointName, input: ScreenshotOptions = {}) => options.evidence.screenshot(name, page, await resolveScreenshotOptions(page, input)),
    async record<Result>(input: RecordingOptions | (() => Promise<Result>), next?: () => Promise<Result>): Promise<Result> {
      const recordingOptions = typeof input === "function" ? Object.freeze({}) : await resolveRecordingOptions(page, input)
      const run = typeof input === "function" ? input : next
      if (!run) throw new AutomationError("capture-failed", "Recording callback is required.")
      return options.evidence.record(page, recordingOptions, run)
    },
  })

  return Object.freeze({ mouse, keyboard, layers, evidence })
}

export async function resolveScreenshotOptions(page: Page, options: ScreenshotOptions): Promise<ResolvedScreenshotOptions> {
  const scale = options.scale ?? 1
  return Object.freeze({ scale, ...(options.crop ? { crop: await resolveCaptureCrop(page, options.crop) } : {}) })
}

export async function resolveRecordingOptions(page: Page, options: RecordingOptions): Promise<ResolvedRecordingOptions> {
  if (!options.crop) return Object.freeze({})
  return Object.freeze({ crop: await resolveCaptureCrop(page, options.crop) })
}

async function resolveCaptureCrop(page: Page, crop: CaptureCrop) {
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const background = await resolveBackground(page, crop.background ?? "theme")
  let requested: { x: number; y: number; width: number; height: number }
  if (crop.kind === "node") {
    const padding = nonNegative(crop.padding ?? 24, "capture padding")
    const bounds = (await crop.node.resolve()).bounds
    const x = Math.floor(bounds.x - padding)
    const y = Math.floor(bounds.y - padding)
    requested = { x, y, width: positiveInteger(Math.ceil(bounds.x + bounds.width + padding) - x, "capture width"), height: positiveInteger(Math.ceil(bounds.y + bounds.height + padding) - y, "capture height") }
  } else {
    const width = positiveInteger(crop.width, "capture width")
    const height = positiveInteger(crop.height, "capture height")
    const center = crop.center
      ? await crop.center.resolve()
      : await page.locator(".canvas-viewport").evaluate(element => {
          const bounds = element.getBoundingClientRect()
          return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
        })
    requested = { x: Math.floor(center.x - width / 2), y: Math.floor(center.y - height / 2), width, height }
  }
  const sourceX = Math.max(0, requested.x)
  const sourceY = Math.max(0, requested.y)
  const sourceRight = Math.min(viewport.width, requested.x + requested.width)
  const sourceBottom = Math.min(viewport.height, requested.y + requested.height)
  if (sourceRight <= sourceX || sourceBottom <= sourceY) throw new AutomationError("capture-failed", "Capture crop is outside the viewport.")
  return Object.freeze({
    viewport: Object.freeze({ width: viewport.width, height: viewport.height }),
    source: Object.freeze({ x: sourceX, y: sourceY, width: sourceRight - sourceX, height: sourceBottom - sourceY }),
    output: Object.freeze({ width: requested.width, height: requested.height, offsetX: sourceX - requested.x, offsetY: sourceY - requested.y }),
    background,
  })
}

function isNodeKind(value: string | null): value is NodeKind {
  return value === "component" || value === "frame" || value === "rectangle" || value === "shape" || value === "shader" || value === "text"
}

function isResizeHandle(value: string | null): value is ResizeHandle {
  return value === "top-left" || value === "top" || value === "top-right" || value === "right" || value === "bottom-right" || value === "bottom" || value === "bottom-left" || value === "left"
}

function isRotationHandle(value: string | null): value is RotationHandle {
  return value === "top-left" || value === "top-right" || value === "bottom-right" || value === "bottom-left"
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 8192) throw new AutomationError("capture-failed", `Invalid ${label}.`)
  return value
}

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 4096) throw new AutomationError("capture-failed", `Invalid ${label}.`)
  return value
}

async function resolveBackground(page: Page, background: "theme" | `#${string}`): Promise<`#${string}`> {
  if (background !== "theme") {
    if (!/^#[\da-f]{6}$/iu.test(background)) throw new AutomationError("capture-failed", "Capture background must be a six-digit hex color.")
    return background.toLowerCase() as `#${string}`
  }
  return page.evaluate(() => {
    const elements = [document.querySelector(".canvas-viewport"), document.querySelector(".editor-root"), document.body, document.documentElement]
    for (const element of elements) {
      if (!element) continue
      const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/u.exec(getComputedStyle(element).backgroundColor)
      if (!match || Number(match[4] ?? 1) === 0) continue
      return `#${[match[1], match[2], match[3]].map(value => Number(value).toString(16).padStart(2, "0")).join("")}` as `#${string}`
    }
    return "#202124"
  })
}

function escapeAttribute(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}
