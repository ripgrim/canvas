import { useSyncExternalStore } from 'react'
const subscribe = (notify: () => void) => {
  const stop = service.subscribe(notify)
  return () => stop()
}
const getSnapshot = () => service.cachedSnapshot
export function Panel() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)
  return <Widget value={snapshot} />
}
