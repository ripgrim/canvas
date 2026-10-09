import type { ComponentProps } from 'react'

export function Label(props: ComponentProps<'label'>) {
  return <label {...props} style={{ padding: '4px 0', ...props.style }} />
}
