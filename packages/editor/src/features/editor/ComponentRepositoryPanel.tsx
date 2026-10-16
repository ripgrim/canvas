import { useState, useSyncExternalStore } from 'react'
import { Button, Check, CodeBlock, Icon, Text } from '../../design-system/atoms'
import { ComponentAuthoringDialog, ComponentAuthoringSection, ComponentKitAction, ComponentKitSection, ComponentRepositoryChoice, ComponentRepositoryChoices, ComponentRepositoryCommitLink, ComponentRepositoryError, ComponentRepositoryPreview, ComponentRepositoryReview, ComponentRepositorySummary } from '../../design-system/component-kit-atoms'
import type { EditorRepositoryDocsReview } from '../../capabilities'
import { componentKitCopy as copy } from './component-kit-copy'
import { documentStore } from './document-store'
import { hostedRepositoryService } from './hosted-repository-service'

export function RepositoryDocsReviewDialog({ review, open, approved, container, busy, onApprovedChange, onOpenChange, onSave }: { review: NonNullable<EditorRepositoryDocsReview['preparedBundle']>; open: boolean; approved: boolean; container: HTMLElement | null; busy: boolean; onApprovedChange: (approved: boolean) => void; onOpenChange: (open: boolean) => void; onSave: () => void }) {
  return <ComponentAuthoringDialog open={open} container={container} title={copy.reviewDocs} closeLabel={copy.cancel} saveLabel={copy.saveDocs} saveDisabled={!approved || busy} onOpenChange={onOpenChange} onSave={onSave}>
    <ComponentAuthoringSection title={copy.repositoryDocsScope}><Text roleName="muted">{copy.docsFileCount(review.files.length, review.validation.length)}</Text></ComponentAuthoringSection>
    {review.files.map(file => <ComponentAuthoringSection key={file.path} title={file.path}><CodeBlock value={file.diff} /></ComponentAuthoringSection>)}
    <ComponentAuthoringSection title={copy.docsChecks}><Text roleName="muted">{review.validation.map(check => check.name).join(', ')}</Text></ComponentAuthoringSection>
    <Check label={copy.reviewedDocs} checked={approved} disabled={busy} onChange={onApprovedChange} />
  </ComponentAuthoringDialog>
}

export function repositoryDocsReviewPresentation(review: EditorRepositoryDocsReview | null, file: Readonly<{ fileId: string; revision: number }> | null, fileChanged = false) {
  const bundle = review?.preparedBundle ?? null
  const current = Boolean(review && file && !fileChanged && review.fileId === file.fileId && review.fileRevision === file.revision)
  const ready = Boolean(bundle && current && review?.status === 'prepared')
  const expired = Boolean(bundle && (!current || review?.status === 'stale' || review?.status === 'failed'))
  return Object.freeze({ bundle, ready, expired })
}

export function repositoryCommitUrl(fullName: string, commitSha: string): string | null {
  const parts = fullName.split('/')
  if (parts.length !== 2 || parts.some(part => !part) || !/^[a-f0-9]{40}$/.test(commitSha)) return null
  return `https://github.com/${parts.map(encodeURIComponent).join('/')}/commit/${commitSha}`
}

export function ComponentRepositoryPanel() {
  const document = useSyncExternalStore(documentStore.subscribe, documentStore.getViewSnapshot, documentStore.getViewSnapshot)
  const repository = useSyncExternalStore(hostedRepositoryService.subscribe, hostedRepositoryService.getSnapshot, hostedRepositoryService.getSnapshot)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewApproved, setReviewApproved] = useState(false)
  const [reviewContainer, setReviewContainer] = useState<HTMLElement | null>(null)
  if (!repository.available) return null

  const fileChanged = document.dirty || document.saving
  const docsReview = repository.docsReview
  const review = repositoryDocsReviewPresentation(docsReview, document.file, fileChanged)
  const reviewBundle = review.bundle
  const reviewTitle = review.expired ? copy.docsReviewExpired : docsReview?.status === 'saved' ? copy.docsSaved : docsReview?.status === 'queued_save' || docsReview?.status === 'saving' ? copy.savingDocs : copy.docsReady
  const reviewDetail = docsReview?.status === 'saved' && docsReview.committedSha ? copy.docsSavedCommit(docsReview.committedSha) : reviewBundle ? copy.docsFileCount(reviewBundle.files.length, reviewBundle.validation.length) : ''
  const commitUrl = docsReview?.status === 'saved' && docsReview.committedSha && repository.connection ? repositoryCommitUrl(repository.connection.repository.fullName, docsReview.committedSha) : null
  const reviewAction = commitUrl
    ? <ComponentRepositoryCommitLink href={commitUrl} label={copy.openCommit} />
    : review.ready
      ? <Button variant="ghost" disabled={document.blocked || fileChanged || repository.status === 'busy'} onClick={event => { setReviewContainer(event.currentTarget.closest<HTMLElement>('.editor-root')); setReviewApproved(false); setReviewOpen(true) }}>{copy.reviewChanges}</Button>
      : review.expired ? <Button variant="ghost" disabled={document.blocked || fileChanged || repository.status === 'busy'} onClick={() => hostedRepositoryService.prepareDocs()}>{copy.prepareDocs}</Button> : undefined
  const retry = docsReview?.status === 'stale' || docsReview?.status === 'failed'
    ? <Button variant="ghost" disabled={document.blocked || fileChanged} onClick={() => hostedRepositoryService.prepareDocs()}>{copy.prepareDocs}</Button>
    : <Button variant="ghost" onClick={() => hostedRepositoryService.retry()}>{copy.retryRepository}</Button>
  const content = repository.connection
    ? <><ComponentRepositorySummary name={repository.connection.repository.fullName} status={repository.scan ? copy.componentCount(repository.scan.componentCount) : copy.connectedRepository} />{repository.preview && <ComponentRepositoryPreview src={repository.preview.url} title={copy.repositoryPreview} />}{reviewBundle && <ComponentRepositoryReview title={reviewTitle} detail={reviewDetail} files={reviewBundle.files.slice(0, 3).map(file => file.path)} {...(reviewAction ? { action: reviewAction } : {})} />}{repository.status === 'error' && <ComponentRepositoryError message={repository.error ?? copy.repositoryUnavailable} action={retry} />}<ComponentKitAction><Button variant="ghost" disabled={document.blocked || repository.status === 'busy'} onClick={() => hostedRepositoryService.scan()}>{repository.operation === 'scanning' ? copy.scanningRepository : copy.scanRepository}</Button>{repository.scan && <Button variant="ghost" disabled={document.blocked || fileChanged || repository.status === 'busy'} onClick={() => hostedRepositoryService.prepareDocs()}>{repository.operation === 'preparing-docs' ? copy.preparingDocs : copy.prepareDocs}</Button>}{repository.scan && repository.executionAvailable && <Button variant="ghost" disabled={document.blocked || repository.status === 'busy'} onClick={() => hostedRepositoryService.build()}>{repository.operation === 'building' ? copy.buildingPreview : repository.preview ? copy.rebuildPreview : copy.buildPreview}</Button>}</ComponentKitAction></>
    : repository.status === 'choosing'
      ? <ComponentRepositoryChoices label={copy.chooseRepository}>{repository.choices.map(choice => <ComponentRepositoryChoice key={choice.id} name={choice.fullName} disabled={document.blocked} onChoose={() => hostedRepositoryService.link(choice.id)} />)}</ComponentRepositoryChoices>
      : repository.status === 'error'
        ? <ComponentRepositoryError message={repository.error ?? copy.repositoryUnavailable} action={<Button variant="ghost" onClick={() => hostedRepositoryService.retry()}>{copy.retryRepository}</Button>} />
        : <ComponentKitAction><Button variant="ghost" disabled={document.blocked || repository.status === 'busy'} onClick={() => hostedRepositoryService.connect()}><Icon name="folder" />{repository.operation === 'connecting' ? copy.connectingRepository : repository.status === 'busy' ? copy.loadingRepositories : copy.connectRepository}</Button></ComponentKitAction>

  return <ComponentKitSection title={copy.repository}>{content}{reviewBundle && <RepositoryDocsReviewDialog review={reviewBundle} open={reviewOpen && review.ready} approved={reviewApproved} container={reviewContainer} busy={repository.status === 'busy'} onApprovedChange={setReviewApproved} onOpenChange={open => { setReviewOpen(open); if (!open) setReviewApproved(false) }} onSave={() => { setReviewOpen(false); setReviewApproved(false); hostedRepositoryService.saveDocs() }} />}</ComponentKitSection>
}
