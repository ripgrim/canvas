import { useState } from 'react'
import type { ColorValue } from '@canvas/repo-engine/appearance'
import { colorToCss, hexColor } from '@canvas/repo-engine/color'
import type { FileCommand, FileDocument } from '@canvas/repo-engine/file-document'
import { resolveColorValue } from '@canvas/repo-engine/file-document'
import { AppearanceLine, AppearanceSection } from '../../design-system/appearance-atoms'
import { ColorPicker } from '../../design-system/color-picker'
import { InspectorColorField, InspectorCountButton, InspectorTextButton } from '../../design-system/inspector-atoms'
import { TokenChooser } from '../../design-system/token-field-atoms'
import { colorTokenOptions } from './appearance-adapters'
import { documentStore } from './document-store'
import { inspectorCopy as copy } from './inspector-copy'
import { replaceSelectionColor, selectionColorGroups } from './selection-colors'

const literal = (hex: string): ColorValue => ({ kind: 'literal', color: hexColor(hex) })

export function SelectionColorsPanel({ file, selection, mode, disabled }: { file: FileDocument; selection: readonly string[]; mode: 'light' | 'dark'; disabled: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const groups = selectionColorGroups(file, selection, nodeId => documentStore.paletteFor(nodeId))
  if (!groups.length) return null
  const shown = expanded ? groups : groups.slice(0, 10)
  const commit = (key: string, nodeIds: readonly string[], value: ColorValue) => documentStore.commands.executeBatch(nodeIds.flatMap((nodeId): FileCommand[] => {
    const node = documentStore.getSnapshot().file?.nodes[nodeId]
    return node && node.type !== 'root' && node.appearance ? [{ type: 'node.setAppearance', nodeId, appearance: replaceSelectionColor(node.appearance, key, value) }] : []
  }))
  const options = colorTokenOptions(file).map(option => {
    const color = resolveColorValue(file.theme, { kind: 'token', tokenId: option.value }, documentStore.paletteFor(groups[0]?.nodeIds[0] ?? ''))
    return { ...option, ...(color ? { color: colorToCss(color) } : {}) }
  })
  return <AppearanceSection id="selection-colors" title={copy.selectionColors}>
    {shown.map((group, index) => <AppearanceLine key={group.key} layout="value-actions">
      <InspectorColorField id={`selection-color-${index}`} label={copy.selectionColor(group.name)} opacityLabel={copy.selectionColorOpacity(group.name)} value={group.resolved} disabled={disabled} swatch={<ColorPicker variant="swatch" label={copy.selectionColor(group.name)} value={group.resolved} mode={mode} disabled={disabled} onChange={value => commit(group.key, group.nodeIds, literal(value))} />} onCommit={value => commit(group.key, group.nodeIds, literal(value))} />
      <TokenChooser id={`selection-color-${index}-token`} label={copy.selectionColorToken(group.name)} placeholder={copy.colorTokens} options={options} disabled={disabled} onChoose={tokenId => commit(group.key, group.nodeIds, { kind: 'token', tokenId })} />
      <InspectorCountButton label={copy.selectColorLayers(group.nodeIds.length, group.name)} count={group.nodeIds.length} disabled={disabled} onClick={() => documentStore.selectMany(group.nodeIds)} />
    </AppearanceLine>)}
    {!expanded && groups.length > 10 && <InspectorTextButton wide label={copy.showAllColors(groups.length)} onClick={() => setExpanded(true)} />}
  </AppearanceSection>
}
