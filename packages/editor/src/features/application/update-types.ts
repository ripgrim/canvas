export type ApplicationUpdateStatus = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

export type ApplicationUpdateSnapshot = Readonly<{
  kind: 'desktop' | 'web'
  channel: 'nightly' | 'stable' | 'web'
  status: ApplicationUpdateStatus
  currentVersion: string
  availableVersion: string | null
  progress: number | null
  releaseNotes: string | null
  checkedAt: string | null
  message: string | null
  reference: string | null
  retryable: boolean
}>

export type ApplicationUpdateRequest =
  | Readonly<{ method: 'getSnapshot' | 'check' | 'download' | 'install'; args: readonly [] }>

export type ApplicationUpdateResponse =
  | Readonly<{ ok: true; value: ApplicationUpdateSnapshot }>
  | Readonly<{ ok: false; error: string; reference: string }>

export type ApplicationUpdateBridge = Readonly<{
  getUpdateSnapshot(): Promise<ApplicationUpdateSnapshot>
  checkForUpdate(): Promise<ApplicationUpdateSnapshot>
  downloadUpdate(): Promise<ApplicationUpdateSnapshot>
  installUpdate(): Promise<ApplicationUpdateSnapshot>
  onUpdateChanged(listener: (snapshot: ApplicationUpdateSnapshot) => void): () => void
}>
