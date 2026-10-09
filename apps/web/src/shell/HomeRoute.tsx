import { useNavigate } from '@tanstack/react-router'
import { HomePage } from '@canvas/editor/home'

/** Home: creating or opening a file navigates to its permanent /file/$fileId address. */
export function HomeRoute() {
  const navigate = useNavigate()
  const open = (fileId: string) => { void navigate({ to: '/file/$fileId', params: { fileId } }) }
  return <HomePage onOpenFile={open} onCreateFile={open} />
}
