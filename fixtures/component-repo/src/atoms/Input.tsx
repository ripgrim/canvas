import type { ComponentProps } from 'react'

export function Input(props: ComponentProps<'input'>) {
  return <input {...props} className={['fixture-input', props.className].filter(Boolean).join(' ')} />
}
