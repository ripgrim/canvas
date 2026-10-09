import type { CapabilityState } from '../../capabilities'

export type HomeFile = Readonly<{
  id: string
  name: string
  location: string
  detail?: string
}>

export type HomeLoadingPhase = Readonly<{
  name: string
  status: 'complete' | 'active' | 'pending'
  completed?: number
}>

export type HomeViewState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'listing' }>
  | Readonly<{ kind: 'loading'; action: 'create' | 'open'; fileName?: string; phases: readonly HomeLoadingPhase[] }>
  | Readonly<{ kind: 'error'; action: 'list' | 'create' | 'open'; message: string; fileName?: string }>

export type HomeProps = Readonly<{
  mode: 'light' | 'dark'
  workspaceName: string
  files: readonly HomeFile[]
  state: HomeViewState
  create: CapabilityState
  openProject?: Readonly<{ label: string; capability: CapabilityState; onSelect: () => void }>
  onCreate: () => void
  onOpen: (fileId: string) => void
  onRetry: () => void
  onBack?: () => void
}>
