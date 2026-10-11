import { track } from '@databuddy/sdk'
import { appVersion } from './version.generated.js'

export type AppPlatform = 'electron' | 'web'
export type TrackingValue = string | number | boolean | null
export type TrackingProperties = Readonly<Record<string, TrackingValue>>
export type CanvasEventName =
  | 'auth_provider_selected'
  | 'file_created'
  | 'file_opened'
  | 'operation_failed'
  | 'sign_in_started'
  | 'sign_in_completed'
  | 'signed_out'

export type TrackingContext = Readonly<{
  app_platform: AppPlatform
  app_version: string
}>

export function appPlatform(scope: typeof globalThis = globalThis): AppPlatform {
  const candidate = scope as typeof globalThis & { designEditor?: unknown }
  return candidate.designEditor ? 'electron' : 'web'
}

export function eventProperties(properties: TrackingProperties = {}, platform = appPlatform()): TrackingProperties & TrackingContext {
  return Object.freeze({ ...properties, app_platform: platform, app_version: appVersion })
}

export function trackCanvasEvent(event: CanvasEventName, properties: TrackingProperties = {}): void {
  try { track(event, eventProperties(properties)) }
  catch (error) { console.warn('Analytics delivery could not start.', error) }
}

export { appVersion }
