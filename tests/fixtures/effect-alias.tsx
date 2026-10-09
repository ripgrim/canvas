import { useEffect as afterRender } from 'react'
export function Panel() {
  afterRender(() => {}, [])
  return <Widget />
}
