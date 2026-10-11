import type { MouseEventHandler } from 'react'
import { Databuddy } from '@databuddy/sdk/react'
import { trackCanvasEvent } from './index.js'
import type { CanvasEventName, TrackingProperties } from './index.js'

export function TrackingRuntime({ clientId }: { clientId: string | undefined }) {
  if (!clientId) return null
  return <Databuddy clientId={clientId} trackWebVitals trackErrors />
}

export function useTrackedClick<T extends Element>(event: CanvasEventName, onClick?: MouseEventHandler<T>, properties?: TrackingProperties): MouseEventHandler<T> {
  return click => {
    trackCanvasEvent(event, properties)
    onClick?.(click)
  }
}
