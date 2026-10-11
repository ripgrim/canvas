import type { CapabilityState } from '../../capabilities'
import type { IconName } from '../../design-system/atoms'
import { ToolRail } from '../../design-system/tool-rail'
import type { ToolRailItem } from '../../design-system/tool-rail'
import { toolRailCopy as copy } from './tool-rail-copy'

export type EditorTool = 'move' | 'scale' | 'hand' | 'frame' | 'shader' | 'text' | 'rectangle' | 'shape' | 'interact'
export type EditorToolAvailability = Readonly<Record<EditorTool, CapabilityState>>

export type EditorToolRailProps = Readonly<{
  active: EditorTool | null
  availability: EditorToolAvailability
  compact?: boolean
  shortcuts?: Readonly<Partial<Record<EditorTool, string>>>
  onSelect: (tool: EditorTool) => void
}>

// Interact is app-specific (pointer goes to the running app), so it stays in its own last group.
const layout: readonly (readonly EditorTool[])[] = [['move', 'scale', 'hand'], ['frame', 'rectangle', 'shape', 'shader', 'text'], ['interact']]
const icons: Readonly<Record<EditorTool, IconName>> = { move: 'move', scale: 'scale', hand: 'hand', frame: 'frame', shader: 'shader', text: 'text', rectangle: 'rectangle', shape: 'shape', interact: 'component' }
const details: Readonly<Partial<Record<EditorTool, string>>> = { interact: copy.interactDetail }

export const editorTools: readonly EditorTool[] = layout.flat()
const compactLayout: readonly (readonly EditorTool[])[] = [['move', 'frame', 'text', 'shape']]

export function EditorToolRail({ active, availability, compact = false, shortcuts, onSelect }: EditorToolRailProps) {
  const item = (tool: EditorTool): ToolRailItem<EditorTool> => {
    const state = availability[tool]
    const shortcut = shortcuts?.[tool]
    const base = { id: tool, label: copy[tool], icon: icons[tool], ...(shortcut ? { shortcut } : {}) }
    const detail = details[tool]
    return state.available ? { ...base, available: true, ...(detail ? { detail } : {}) } : { ...base, available: false, reason: state.reason || copy.unavailable }
  }
  const activeLayout = compact ? compactLayout : layout
  return <ToolRail label={copy.label} groups={activeLayout.map(group => group.map(item))} active={active} orientation={compact ? 'horizontal' : 'vertical'} onSelect={onSelect} />
}
