import * as R from 'react'
const { useEffect: afterRender } = R
export function Panel() {
  afterRender(() => {}, [])
  return <Widget />
}
