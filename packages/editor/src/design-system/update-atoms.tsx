import type { ReactNode } from 'react'
import { Button, Icon, Text } from './atoms'
import './update.css'

export function UpdateRegion({ children }: { children: ReactNode }) {
  return <aside className="update-region" aria-live="polite">{children}</aside>
}

export function UpdateCard({ title, description, progress, progressLabel, dismissLabel, action, secondaryAction, onDismiss }: { title: string; description: string; progress?: number | null; progressLabel: string; dismissLabel: string; action?: ReactNode; secondaryAction?: ReactNode; onDismiss: () => void }) {
  return <section className="update-card">
    <span className="update-card-icon" aria-hidden="true"><Icon name="refresh" /></span>
    <span className="update-card-copy"><Text roleName="strong">{title}</Text><Text roleName="muted">{description}</Text>{typeof progress === 'number' && <progress className="update-progress" max={100} value={progress} aria-label={progressLabel} />}</span>
    <span className="update-card-actions">{secondaryAction}{action}<Button label={dismissLabel} onClick={onDismiss}><Icon name="close" /></Button></span>
  </section>
}
