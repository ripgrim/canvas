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
  type NodeRef,
  type NodeSnapshot,
} from "./index.js"

export type PlaywrightEvidencePort<CheckpointName extends string> = Readonly<{
  screenshot(name: CheckpointName, page: Page): Promise<void>
  record<Result>(page: Page, run: () => Promise<Result>): Promise<Result>
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
    return Object.freeze({
      id,
      resolve,
      bounds,
      center: () => bounds().center(),
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
    screenshot: (name: CheckpointName) => options.evidence.screenshot(name, page),
    async record<Result>(run: () => Promise<Result>): Promise<Result> {
      return options.evidence.record(page, run)
    },
  })

  return Object.freeze({ mouse, keyboard, layers, evidence })
}

function isNodeKind(value: string | null): value is NodeKind {
  return value === "component" || value === "frame" || value === "rectangle" || value === "shape" || value === "shader" || value === "text"
}

function escapeAttribute(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}
