import { createFileRoute } from '@tanstack/react-router'
import { getHostedAuth } from '@canvas/auth/hosted'

const handle = ({ request }: { request: Request }) => getHostedAuth().handler(request)

export const Route = createFileRoute('/api/auth/$')({
  server: { handlers: { GET: handle, POST: handle } },
})
