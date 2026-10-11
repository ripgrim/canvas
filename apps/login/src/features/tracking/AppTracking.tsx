import { TrackingRuntime } from '@canvas/tracking/react'

export function AppTracking() {
  return <TrackingRuntime clientId={import.meta.env.VITE_DATABUDDY_CLIENT_ID} />
}
