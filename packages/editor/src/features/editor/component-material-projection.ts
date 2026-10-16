import type { ComponentDefinition, ComponentMaterial, ComponentPart } from '@canvas/repo-engine/component-model'
import type { FileCommand } from '@canvas/repo-engine/file-document'

export function componentMaterialProjectionCommands(
  definition: ComponentDefinition,
  material: ComponentMaterial,
  parts: readonly ComponentPart[] = definition.parts,
  excludedNodeId?: string,
): FileCommand[] {
  return parts.flatMap(part => part.materialId === material.id && part.nodeId !== excludedNodeId
    ? [{ type: 'node.setAppearance' as const, nodeId: part.nodeId, appearance: structuredClone(material.appearance) }]
    : [])
}
