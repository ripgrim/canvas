import type { ComponentProps } from 'react'

export const AlertPanel = ({ tone = 'calm', ...props }: ComponentProps<'section'> & { tone?: 'calm' | 'urgent' }) => (
  <section {...props} data-tone={tone} className="verified-alert" />
)
