import type { ComponentProps, ReactNode } from 'react'

export type CardProps = ComponentProps<'section'> & { heading?: ReactNode; footer?: ReactNode }

export function Card({ heading, footer, children, ...props }: CardProps) {
  return <section {...props} className={['fixture-card', props.className].filter(Boolean).join(' ')}>{heading}{children}{footer}</section>
}
