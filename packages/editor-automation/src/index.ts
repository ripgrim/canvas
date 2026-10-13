export type Brand<Value, Name extends string> = Value & { readonly __brand: Name }

export type NodeId = Brand<string, "NodeId">
export type ScenarioId = Brand<string, "ScenarioId">
export type SourcePath = Brand<string, "SourcePath">
export type Checkpoint<Name extends string = string> = Brand<Name, "Checkpoint">

export type NodeKind = "component" | "frame" | "rectangle" | "shape" | "shader" | "text"
export type AdapterKind = "browser" | "electron"
export type ModifierKey = "Alt" | "Control" | "Meta" | "Shift"
export type ResizeHandle = "top-left" | "top" | "top-right" | "right" | "bottom-right" | "bottom" | "bottom-left" | "left"

export type Point = Readonly<{ x: number; y: number }>
export type Bounds = Readonly<{ x: number; y: number; width: number; height: number }>

const ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/u

function branded<Value extends string, Name extends string>(value: Value, label: string): Brand<Value, Name> {
  if (!ID.test(value)) throw new Error(`Invalid ${label}.`)
  return value as Brand<Value, Name>
}

export const nodeId = <Value extends string>(value: Value): Brand<Value, "NodeId"> => branded<Value, "NodeId">(value, "node id")
export const scenarioId = <Value extends string>(value: Value): Brand<Value, "ScenarioId"> => branded<Value, "ScenarioId">(value, "scenario id")
export const checkpoint = <Value extends string>(value: Value): Brand<Value, "Checkpoint"> => branded<Value, "Checkpoint">(value, "checkpoint")

export function sourcePath<Value extends string>(value: Value): Brand<Value, "SourcePath"> {
  const normalized = value.replaceAll("\\", "/")
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new Error("Invalid source path.")
  }
  return normalized as Brand<Value, "SourcePath">
}

export interface GeometryTarget {
  resolve(): Promise<Point>
  offset(dx: number, dy: number): GeometryTarget
}

export interface BoundsTarget {
  resolve(): Promise<Bounds>
  center(): GeometryTarget
  corner(position: "top-left" | "top-right" | "bottom-right" | "bottom-left"): GeometryTarget
  resizeHandle(handle: ResizeHandle): GeometryTarget
}

export function geometryTarget(resolve: () => Promise<Point>): GeometryTarget {
  return Object.freeze({
    resolve,
    offset: (dx: number, dy: number) => geometryTarget(async () => {
      const point = await resolve()
      return Object.freeze({ x: point.x + dx, y: point.y + dy })
    }),
  })
}

export function boundsTarget(resolve: () => Promise<Bounds>): BoundsTarget {
  const point = (horizontal: number, vertical: number) => geometryTarget(async () => {
    const bounds = await resolve()
    return Object.freeze({ x: bounds.x + bounds.width * horizontal, y: bounds.y + bounds.height * vertical })
  })
  const handles: Readonly<Record<ResizeHandle, readonly [number, number]>> = Object.freeze({
    "top-left": [0, 0], top: [0.5, 0], "top-right": [1, 0], right: [1, 0.5],
    "bottom-right": [1, 1], bottom: [0.5, 1], "bottom-left": [0, 1], left: [0, 0.5],
  })
  return Object.freeze({
    resolve,
    center: () => point(0.5, 0.5),
    corner: (position: "top-left" | "top-right" | "bottom-right" | "bottom-left") => {
      const [horizontal, vertical] = handles[position]
      return point(horizontal, vertical)
    },
    resizeHandle: (handle: ResizeHandle) => {
      const [horizontal, vertical] = handles[handle]
      return point(horizontal, vertical)
    },
  })
}

export type AutomationFailureCode =
  | "target-not-found"
  | "target-ambiguous"
  | "unsupported-capability"
  | "stale-projection"
  | "adapter-unsupported"
  | "interaction-cancelled"
  | "assertion-failed"
  | "capture-failed"

export class AutomationError extends Error {
  readonly code: AutomationFailureCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(code: AutomationFailureCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message)
    this.name = "AutomationError"
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

export interface NodeSnapshot<Kind extends NodeKind = NodeKind> {
  readonly id: NodeId
  readonly kind: Kind
  readonly name: string
  readonly bounds: Bounds
}

export interface NodeRef<Kind extends NodeKind = NodeKind> {
  readonly id: NodeId
  resolve(): Promise<NodeSnapshot<Kind>>
  bounds(): BoundsTarget
  center(): GeometryTarget
  expectKind<Next extends Kind>(kind: Next): Promise<NodeRef<Next>>
}

export interface MouseApi {
  click(target: GeometryTarget): Promise<void>
  move(target: GeometryTarget): Promise<void>
  drag(
    from: GeometryTarget,
    to: GeometryTarget,
    options?: Readonly<{
      modifiers?: readonly ModifierKey[]
      steps?: number
      whileHeld?: () => Promise<void>
    }>,
  ): Promise<void>
}

export interface KeyboardApi {
  press(key: string): Promise<void>
  chord(keys: readonly string[]): Promise<void>
  type(text: string): Promise<void>
}

export interface LayersApi {
  node(id: NodeId): NodeRef
  named(name: string): Promise<NodeRef>
  selected(): Promise<readonly NodeRef[]>
}

export interface EvidenceApi<CheckpointName extends string> {
  screenshot(name: CheckpointName): Promise<void>
  record<Result>(run: () => Promise<Result>): Promise<Result>
}

export interface EditorAutomation<CheckpointName extends string = string> {
  readonly mouse: MouseApi
  readonly keyboard: KeyboardApi
  readonly layers: LayersApi
  readonly evidence: EvidenceApi<CheckpointName>
}

export type ScenarioDefinition<
  Id extends string,
  CheckpointName extends string,
> = Readonly<{
  id: Brand<Id, "ScenarioId">
  title: string
  capabilities: readonly string[]
  adapters: readonly AdapterKind[]
  evidence: Readonly<{
    screenshots: readonly CheckpointName[]
    video: false | Readonly<{ region: "editor" | "canvas"; maxDurationMs: number }>
  }>
  run(context: EditorAutomation<CheckpointName>): Promise<void>
}>

export function defineScenario<Id extends string, CheckpointName extends string>(
  definition: ScenarioDefinition<Id, CheckpointName>,
): ScenarioDefinition<Id, CheckpointName> {
  if (!definition.title.trim()) throw new Error("Scenario title is required.")
  if (!definition.capabilities.length) throw new Error("Scenario capabilities are required.")
  if (!definition.adapters.length) throw new Error("Scenario adapters are required.")
  if (new Set(definition.evidence.screenshots).size !== definition.evidence.screenshots.length) {
    throw new Error("Scenario checkpoints must be unique.")
  }
  return Object.freeze({
    ...definition,
    capabilities: Object.freeze([...definition.capabilities]),
    adapters: Object.freeze([...definition.adapters]),
    evidence: Object.freeze({ ...definition.evidence, screenshots: Object.freeze([...definition.evidence.screenshots]) }),
  })
}
