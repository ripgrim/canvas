import { createFileRoute } from '@tanstack/react-router'
import { FileLoadingPage } from '@canvas/editor/file'
import { FileRoute } from '../shell/FileRoute'
import { fileRouteHead, fileRouteLoaderDeps, loadFileRoute } from '../features/files/file-route-service'
import { validateFileRouteSearch } from '../features/files/file-route-validation'

export const Route = createFileRoute('/file/$fileId')({
  validateSearch: validateFileRouteSearch,
  loaderDeps: fileRouteLoaderDeps,
  ssr: false,
  loader: loadFileRoute,
  head: fileRouteHead,
  pendingComponent: FileLoadingPage,
  component: FileRouteComponent,
})

function FileRouteComponent() { return <FileRoute fileId={Route.useParams().fileId} result={Route.useLoaderData()} /> }
