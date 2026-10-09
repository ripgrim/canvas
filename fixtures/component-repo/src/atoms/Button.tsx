import type { ComponentProps } from 'react'

export type ButtonProps = ComponentProps<'button'> & { variant?: 'primary' | 'quiet' }

export function Button({ variant = 'primary', ...props }: ButtonProps) {
  return <button {...props} data-variant={variant} className={['fixture-button', props.className].filter(Boolean).join(' ')} />
}
