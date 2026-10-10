import { ContextMenu } from '../../design-system/context-menu'
import type { ContextMenuAction } from '../../design-system/context-menu'
import { sidebarCopy as copy } from './sidebar-copy'

export function PageContextMenu({ position, canDelete, onRename, onDelete, onClose }: { position: { x: number; y: number }; canDelete: boolean; onRename: () => void; onDelete: () => void; onClose: () => void }) {
  const groups: ContextMenuAction[][] = [[
    { id: 'rename-page', label: copy.renamePage, onSelect: onRename },
    { id: 'delete-page', label: copy.deletePage, disabled: !canDelete, ...(!canDelete ? { reason: copy.lastPageReason } : { onSelect: onDelete }) },
  ]]
  return <ContextMenu position={position} label={copy.pageActions} groups={groups} onClose={onClose} />
}
