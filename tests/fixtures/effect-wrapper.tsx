import { useEffect } from 'react'
export function useHiddenSubscription() {
  useEffect(() => subscribe(), [])
}
