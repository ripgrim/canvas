import { createFileRoute } from '@tanstack/react-router'
import { HomeRoute } from '../shell/HomeRoute'

export const Route = createFileRoute('/')({ component: HomeRoute, ssr: false })
