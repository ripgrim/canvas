import { FileLoading, FileScreen } from '../features/application/FileScreen'
import type { FileLoadingProps, FileScreenProps } from '../features/application/FileScreen'

export function FilePage(props: FileScreenProps) { return <FileScreen {...props} /> }
export function FileLoadingPage(props: FileLoadingProps = {}) { return <FileLoading {...props} /> }
