import { useSyncExternalStore } from 'react'
import { supportedInputTypes } from '@canvas/repo-engine/document'
import { childrenOf } from '@canvas/repo-engine/file-document'
import type { ComponentNode, FileDocument } from '@canvas/repo-engine/file-document'
import type { Atom } from './types'
import { PropertyField, PropertyGroup, PropertyHint, PropertySelect, PropertySource, PropertyToggle, PropertyValue } from '../../design-system/property-atoms'
import type { PropertyOption } from '../../design-system/property-atoms'
import { documentStore } from './document-store'
import { editorStore } from './store'
import { propertiesCopy as copy } from './properties-copy'

type PropDefinition = Atom['props'][number]
type EditorKind = { type: 'text' } | { type: 'number' } | { type: 'boolean' } | { type: 'enum'; values: string[] }

const fixtureProps: Record<string, readonly string[]> = {
  Button: ['children', 'variant', 'type', 'disabled'],
  Card: ['heading', 'footer', 'id'],
  Input: ['id', 'name', 'type', 'placeholder', 'disabled', 'required', 'maxLength'],
  Label: ['children', 'htmlFor', 'id'],
}

export function literalOptions(type: string): string[] | null {
  const parts = type.split('|').map(part => part.trim()).filter(part => !['undefined', 'null'].includes(part))
  if (!parts.length) return null
  const values = parts.map(part => /^(['"])([^'"]+)\1$/.exec(part)?.[2])
  return values.every((value): value is string => typeof value === 'string') ? values : null
}

export function propertyEditor(atom: Atom, definition: PropDefinition): EditorKind | null {
  if (atom.kind !== 'atom' || atom.status !== 'bound' || !fixtureProps[atom.exportName]?.includes(definition.name)) return null
  const choices = literalOptions(definition.type)
  if (choices) return { type: 'enum', values: choices }
  if (atom.exportName === 'Input' && definition.name === 'type' && definition.type.includes('HTMLInputTypeAttribute')) return { type: 'enum', values: [...supportedInputTypes] }
  const members = definition.type.split('|').map(member => member.trim())
  if (members.includes('string') && members.includes('number')) return null
  if (members.includes('boolean')) return { type: 'boolean' }
  if (members.includes('number')) return { type: 'number' }
  if (members.includes('string') || definition.type.includes('ReactNode')) return { type: 'text' }
  return null
}

function EditableProp({ file, atom, node, definition, disabled }: { file: FileDocument; atom: Atom; node: ComponentNode; definition: PropDefinition; disabled: boolean }) {
  const editor = propertyEditor(atom, definition)
  if (!editor) return null
  const name = definition.name
  const id = `instance-${node.id}-${name}`
  const value = node.props[name]
  const slotted = childrenOf(file, node.id, name).length
  if (slotted) return <PropertyValue label={name} value={copy.slotCount(name, slotted)} />
  if (editor.type === 'boolean') return <PropertyToggle id={id} label={name} checked={value === true} disabled={disabled} onChange={checked => documentStore.commands.setProps(node.id, { [name]: checked })} />
  if (editor.type === 'enum') {
    const options: PropertyOption[] = [{ value: '', label: copy.emptyValue }, ...editor.values.map(option => ({ value: option, label: option }))]
    return <PropertySelect id={id} label={name} value={typeof value === 'string' ? value : ''} options={options} disabled={disabled} onChange={next => next ? documentStore.commands.setProps(node.id, { [name]: next }) : documentStore.commands.removeProps(node.id, [name])} />
  }
  if (editor.type === 'number') return <PropertyField id={id} label={name} type="number" disabled={disabled} value={typeof value === 'number' ? String(value) : ''} onChange={next => {
    if (next === '') documentStore.commands.removeProps(node.id, [name])
    else if (/^-?\d+$/.test(next)) documentStore.commands.setProps(node.id, { [name]: Number(next) })
  }} />
  return <PropertyField id={id} label={name} disabled={disabled} value={typeof value === 'string' ? value : ''} onChange={next => documentStore.commands.setProps(node.id, { [name]: next })} />
}

export function ComponentProperties({ atoms }: { atoms: Atom[] }) {
  const { file, selection, blocked } = useSyncExternalStore(documentStore.subscribe, documentStore.getSnapshot, documentStore.getSnapshot)
  const live = useSyncExternalStore(editorStore.subscribe, () => !editorStore.getSnapshot().compositionPreview, () => !editorStore.getSnapshot().compositionPreview)
  if (selection.length > 1) return <PropertyGroup title={copy.properties}><PropertyHint>{copy.multiple}</PropertyHint></PropertyGroup>
  const selected = file?.nodes[selection[0] ?? '']
  const node = selected?.type === 'component' ? selected : undefined
  const atom = atoms.find(candidate => candidate.componentId === node?.componentId)
  if (!file || !node || !atom) return <PropertyGroup title={copy.properties}><PropertyHint>{copy.choose}</PropertyHint></PropertyGroup>
  const definitions = atom.props.filter(definition => propertyEditor(atom, definition))
  const otherProps = Object.keys(node.props).filter(name => !definitions.some(definition => definition.name === name))
  const fromCode = atom.props.filter(definition => !propertyEditor(atom, definition) && !Object.hasOwn(node.props, definition.name))
  return <>
    <PropertyGroup title={copy.properties}><PropertyHint>{live ? copy.liveEditNotice : copy.instanceScope}</PropertyHint>{definitions.length ? definitions.map(definition => <EditableProp key={definition.name} file={file} atom={atom} node={node} definition={definition} disabled={blocked} />) : <PropertyHint>{copy.noEditable}</PropertyHint>}{otherProps.map(name => <PropertyValue key={name} label={name} value={String(node.props[name])} />)}{fromCode.map(definition => <PropertySource key={definition.name} label={definition.name} value={copy.fromCode} />)}{fromCode.length > 0 && <PropertyHint>{copy.unsupported}</PropertyHint>}</PropertyGroup>
    <PropertyGroup title={copy.source}><PropertyValue label={copy.sourcePath} value={atom.path} /><PropertyValue label={copy.sourceExport} value={atom.exportName} /></PropertyGroup>
  </>
}
