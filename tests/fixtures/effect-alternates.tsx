import { useLayoutEffect, useInsertionEffect } from 'react'
export function Panel() {
  useLayoutEffect(() => {}, [])
  useInsertionEffect(() => {}, [])
  return <Widget />
}
