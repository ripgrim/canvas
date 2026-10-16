import type { ReactNode } from 'react'
import { StartupRoot, StartupStatus } from '../../design-system/startup-atoms'

export function ApplicationStartup({ label, title, detail, children }: { label: string; title: string; detail?: string | undefined; children?: ReactNode }) {
  return <StartupRoot label={label}><StartupStatus title={title} detail={detail}>{children}</StartupStatus></StartupRoot>
}
