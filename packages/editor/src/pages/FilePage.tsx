import { FileLoading, FileScreen } from '../features/application/FileScreen'
import type { FileScreenProps } from '../features/application/FileScreen'

export function FilePage(props: FileScreenProps) { return <FileScreen {...props} /> }
export function FileLoadingPage() { return <FileLoading /> }
