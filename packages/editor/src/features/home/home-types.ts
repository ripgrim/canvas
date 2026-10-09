import type { CapabilityState } from '../../capabilities'

export type HomeFile = Readonly<{ id: string; name: string; location: string; updatedAt?: string }>

// Pass only phases whose work has actually started, in start order.
export type HomePhase = Readonly<{ name: string; state: 'active' | 'done'; detail?: string }>

export type HomeStatus =
  | Readonly<{ kind: 'starting'; phases: readonly HomePhase[] }>
  | Readonly<{ kind: 'ready' }>
  | Readonly<{ kind: 'creating'; phases: readonly HomePhase[] }>
  | Readonly<{ kind: 'opening'; fileId: string; fileName: string; phases: readonly HomePhase[] }>
  | Readonly<{ kind: 'error'; operation: 'list' | 'create' | 'open'; message: string; fileName?: string }>

export type HomeViewProps = Readonly<{
  mode: 'light' | 'dark'
  workspaceName: string
  files: readonly HomeFile[]
  status: HomeStatus
  create: CapabilityState
  open: CapabilityState
  onCreate: () => void
  onOpen: (fileId: string) => void
  onRetry: () => void
  onBack?: () => void
  onToggleMode?: () => void
}>
