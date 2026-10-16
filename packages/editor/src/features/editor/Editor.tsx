import { useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { Button, Check, CodeBlock, Icon, Layout, Popup, Surface, Text, ThemeRoot } from '../../design-system/atoms'
import { Message, PanelHeader, ValuePair } from '../../design-system/molecules'
import { editorCopy as copy } from './copy'
import { editorStore as store } from './store'
import type { EditorState } from './store'
import { previewConnection } from './preview-service'
import { documentStore } from './document-store'
import type { DocumentState } from './document-store'
import { CanvasWorkspace } from './CanvasWorkspace'
import { canvasCopy } from './canvas-copy'
import { DocumentLayers } from './DocumentLayers'
import { ComponentModelProperties } from './ComponentModelProperties'
import { ComponentMasterProperties } from './ComponentMasterProperties'
import { ComponentKitPanel } from './ComponentKitPanel'
import { componentKitNavigation, componentKitSidebarView } from './component-kit-navigation'
import { ComponentRepositoryPanel } from './ComponentRepositoryPanel'
import { ComponentCreationDialog } from './ComponentCreationDialog'
import { componentKitCopy } from './component-kit-copy'
import { PageContextMenu } from './PageContextMenu'
import { editorKeyDown, editorKeyUp } from './keyboard-service'
import { PageInspector, SelectionInspector } from './InspectorPanels'
import { SidebarAction, SidebarPageRow, SidebarSection, SidebarStack, SidebarTabPanel, SidebarTabs } from '../../design-system/sidebar-atoms'
import { ThemePanel } from './ThemePanel'
import { sidebarCopy } from './sidebar-copy'
import { focusSequence, sidebarViewFor, themeFocus } from './theme-focus'
import type { SidebarChoice } from './theme-focus'
import { FileHomeButton, HeaderIconButton, MobileSheet, PanelHeaderActions, PanelHeaderBar, PanelHeaderTitle, PanelResizer, PanelToolbar, PanelToolbarActions } from '../../design-system/shell-atoms'
import { repositoryConnectionService } from './repository-service'
import { connectedRegistryAtoms } from './component-registry'
import { authSessionService } from '../application/auth-service'
import { authCopy } from '../application/auth-copy'
import { ToastRegion } from '../../design-system/toast-atoms'
import { collaborationService } from '../collaboration/collaboration-service'
import { CollaborationPresence } from '../collaboration/CollaborationPresence'
import { mobilePanelVisibility, mobileViewport, toggleMobilePanel } from './mobile-editor'
import type { EditorMobilePanel } from './mobile-editor'
import { canvasComponentNode } from './component-canvas-link'
import { layerPresentation } from './layer-presentation'

function FileHeader({ state, onHome, onTogglePanel }: { state: EditorState; onHome?: (() => void) | undefined; onTogglePanel: () => void }) {
  const name = state.snapshot?.composition.name ?? copy.file
  return <PanelHeaderBar><FileHomeButton label={copy.files} disabled={!onHome || Boolean(state.busy)} onClick={() => onHome?.()} /><PanelHeaderTitle title={name}>{name}</PanelHeaderTitle><PanelHeaderActions><HeaderIconButton label={canvasCopy.hideLayers} icon="panel-left" onClick={onTogglePanel} /></PanelHeaderActions></PanelHeaderBar>
}

function ActionsHeader({ state, readOnly = false, onTogglePanel }: { state: EditorState; readOnly?: boolean; onTogglePanel: () => void }) {
  const auth = useSyncExternalStore(authSessionService.subscribe, authSessionService.getSnapshot, authSessionService.getSnapshot)
  const [accountOpen, setAccountOpen] = useState(false)
  const reloadLabel = state.snapshot ? state.capabilities.runtime === 'browser' ? copy.reloadDraft : copy.refresh : state.capabilities.openLabel
  const signInLabel = auth.status === 'signing-in' ? authCopy.signingIn : ['callback-expired', 'denied', 'offline', 'revoked', 'error'].includes(auth.status) ? authCopy.signInAgain : authCopy.signIn
  const accountAction = () => {
    if (auth.status === 'signed-in' || auth.status === 'unavailable') setAccountOpen(true)
    else authSessionService.signIn()
  }
  return <><PanelToolbar label={copy.panelActions}><HeaderIconButton compact label={canvasCopy.hideProperties} icon="selection" onClick={onTogglePanel} /><CollaborationPresence /><PanelToolbarActions><HeaderIconButton compact label={reloadLabel} icon={state.snapshot ? 'refresh' : 'plus'} disabled={Boolean(state.busy)} onClick={() => void (state.snapshot ? store.refresh() : store.open())} /><HeaderIconButton compact label={state.mode === 'light' ? copy.themeDark : copy.themeLight} icon={state.mode === 'light' ? 'moon' : 'sun'} onClick={() => store.setAppearance(state.mode === 'light' ? 'dark' : 'light')} />{!readOnly && state.prepared && <HeaderIconButton compact label={copy.review} icon="code" pressed={state.reviewOpen} onClick={() => store.set({ reviewOpen: !state.reviewOpen })} />}<Button variant="secondary" disabled={auth.status === 'signing-in'} title={auth.message ?? undefined} onClick={accountAction}>{auth.status === 'signed-in' ? auth.user?.name : signInLabel}</Button>{!readOnly && <Button variant="secondary" disabled={!state.snapshot} onClick={() => void store.openShare()}>{copy.share}</Button>}</PanelToolbarActions></PanelToolbar><Popup mode={state.mode} closeLabel={copy.close} open={accountOpen} onOpenChange={setAccountOpen} title={authCopy.account}>{auth.status === 'signed-in' && auth.user ? <Layout roleName="stack"><Text roleName="strong">{auth.user.name}</Text><Text roleName="muted">{auth.user.email}</Text><Button variant="outline" onClick={() => { setAccountOpen(false); authSessionService.signOut() }}>{authCopy.signOut}</Button></Layout> : <Layout roleName="stack"><Text>{auth.message ?? authCopy.unavailable}</Text>{auth.status !== 'unavailable' && <Button variant="primary" onClick={() => { setAccountOpen(false); authSessionService.signIn() }}>{authCopy.github}</Button>}</Layout>}</Popup></>
}

function ShareDialog({ state }: { state: EditorState }) {
  return <Popup mode={state.mode} closeLabel={copy.close} open={state.shareOpen} onOpenChange={shareOpen => store.set({ shareOpen })} title={copy.share}><ShareDialogContent state={state} /></Popup>
}

export function ShareDialogContent({ state }: { state: EditorState }) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const copyLink = async () => {
    const url = store.shareUrl()
    if (!url) { setCopyFailed(true); return }
    try { await navigator.clipboard.writeText(url); setCopied(true); setCopyFailed(false) }
    catch { setCopied(false); setCopyFailed(true) }
  }
  return <Layout roleName="stack">
    {state.shareBusy && state.shareAccess === null ? <Text roleName="muted">{copy.shareLoading}</Text> : state.shareAccess === null ? <><Text>{state.shareError ?? copy.shareUnavailable}</Text><Button variant="outline" onClick={() => void store.openShare()}>{copy.shareReload}</Button></> : <>
      {state.shareError && <Text>{state.shareError}</Text>}
      <Button variant={state.shareDraft === 'private' ? 'secondary' : 'outline'} active={state.shareDraft === 'private'} onClick={() => { setCopied(false); store.setShareDraft('private') }}>{copy.sharePrivate}</Button>
      <Button variant={state.shareDraft === 'view' ? 'secondary' : 'outline'} active={state.shareDraft === 'view'} onClick={() => { setCopied(false); store.setShareDraft('view') }}>{copy.sharePublic}</Button>
      <Text roleName="muted">{state.shareDraft === 'view' ? copy.sharePublicHint : copy.sharePrivateHint}</Text>
      {state.shareDraft !== state.shareAccess && <Button variant="primary" disabled={state.shareBusy} onClick={() => void store.saveShare()}>{state.shareBusy ? copy.shareUpdating : copy.shareUpdate}</Button>}
      <Button variant="outline" disabled={state.shareBusy} onClick={() => void copyLink()}>{copied ? copy.shareCopied : copy.shareCopy}</Button>
      {copyFailed && <Text roleName="muted">{copy.shareCopyFailed}</Text>}
    </>}
  </Layout>
}

type SidebarKey = 'pages' | 'layers'
type SidebarView = 'design' | 'theme' | 'kit' | 'sources'
const sidebarViews = [{ value: 'design', label: sidebarCopy.design }, { value: 'theme', label: sidebarCopy.theme }, { value: 'kit', label: componentKitCopy.tab }, { value: 'sources', label: sidebarCopy.sources }] as const satisfies readonly { value: SidebarView; label: string }[]

function Library({ state, document, atoms, header, mobile = false, onPageChange }: { state: EditorState; document: DocumentState; atoms: ReturnType<typeof connectedRegistryAtoms>; header: ReactNode; mobile?: boolean; onPageChange?: ((pageId: string) => void) | undefined }) {
  const pages = document.file?.pages ?? []
  const openPage = (pageId: string) => { if (onPageChange) onPageChange(pageId); else documentStore.setPage(pageId) }
  const addPage = () => { const pageId = documentStore.commands.createPage({ activate: !onPageChange }); if (pageId && onPageChange) onPageChange(pageId) }
  const duplicatePage = (pageId: string) => { const copyId = documentStore.commands.duplicatePage(pageId); if (copyId && onPageChange) onPageChange(copyId) }
  const deletePage = (pageId: string) => {
    const file = documentStore.getSnapshot().file
    if (!file || file.pages.length < 2) return
    const index = file.pages.findIndex(page => page.id === pageId)
    const fallback = file.pages[index === 0 ? 1 : index - 1]?.id
    const active = documentStore.getSnapshot().pageId === pageId
    if (documentStore.commands.deletePage(pageId) && active && fallback && onPageChange) onPageChange(fallback)
  }
  const [open, setOpen] = useState<Record<SidebarKey, boolean>>({ pages: true, layers: true })
  const [renamingPage, setRenamingPage] = useState<string | null>(null)
  const [pageMenu, setPageMenu] = useState<{ pageId: string; x: number; y: number } | null>(null)
  // Edit token requests (theme-focus) open the Theme tab; a later manual choice takes over until the next request.
  const focus = useSyncExternalStore(themeFocus.subscribe, themeFocus.getSnapshot, themeFocus.getSnapshot)
  const kitLocation = useSyncExternalStore(componentKitNavigation.subscribe, componentKitNavigation.getSnapshot, componentKitNavigation.getSnapshot)
  const storedView = sidebarViews.some(option => option.value === state.tab) ? state.tab as SidebarView : 'design'
  const [choice, setChoice] = useState<SidebarChoice & Readonly<{ kitAt: number }>>(() => ({ view: storedView, at: focusSequence(themeFocus.getSnapshot()), kitAt: 0 }))
  const requestedView = componentKitSidebarView(kitLocation, document.file?.fileId, { view: sidebarViewFor(focus, choice), kitAt: choice.kitAt })
  const view: SidebarView = document.readOnly ? 'design' : requestedView
  const setView = (next: SidebarView) => {
    store.set({ tab: next })
    setChoice(current => ({ view: next, at: focusSequence(themeFocus.getSnapshot()), kitAt: Math.max(current.kitAt, kitLocation?.sequence ?? 0) }))
  }
  const section = (key: SidebarKey, title: string, count?: number) => ({ expanded: open[key], toggleLabel: open[key] ? sidebarCopy.collapse(title, count) : sidebarCopy.expand(title, count), onToggle: () => setOpen(current => ({ ...current, [key]: !current[key] })) })
  if (mobile) return <DocumentLayers readOnly={document.readOnly} />
  return <Surface roleName="left-rail" label={sidebarCopy.label}>{header}{!document.readOnly && <SidebarTabs label={sidebarCopy.views} idPrefix="sidebar" value={view} options={sidebarViews} onChange={setView} />}
    {view === 'theme' ? <SidebarTabPanel idPrefix="sidebar" value="theme"><ThemePanel /></SidebarTabPanel> : view === 'kit' ? <SidebarTabPanel idPrefix="sidebar" value="kit"><ComponentKitPanel atoms={atoms} onOpenCanvas={() => setView('design')} /></SidebarTabPanel> : view === 'sources' ? <SidebarTabPanel idPrefix="sidebar" value="sources"><ComponentRepositoryPanel /></SidebarTabPanel> : <SidebarTabPanel idPrefix="sidebar" value="design"><SidebarStack>
    <SidebarSection id="pages" title={sidebarCopy.pages} count={pages.length} {...section('pages', sidebarCopy.pages, pages.length)} {...(!document.readOnly ? { actions: <SidebarAction label={sidebarCopy.addPage} icon="plus" disabled={!document.file || document.blocked || Boolean(state.busy)} onSelect={addPage} /> } : {})}>{pages.map(page => <SidebarPageRow key={page.id} pageId={page.id} name={page.name} selected={page.id === document.pageId} renaming={!document.readOnly && renamingPage === page.id} renameLabel={sidebarCopy.renamePageName(page.name)} onSelect={() => openPage(page.id)} {...(!document.readOnly ? { onRename: () => { setPageMenu(null); setRenamingPage(page.id) }, onRenameCommit: (name: string) => { documentStore.commands.renamePage(page.id, name); setRenamingPage(null) }, onRenameCancel: () => setRenamingPage(null), onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => { event.preventDefault(); event.stopPropagation(); setRenamingPage(null); setPageMenu({ pageId: page.id, x: event.clientX, y: event.clientY }) } } : {})} />)}</SidebarSection>
    <SidebarSection id="layers" title={sidebarCopy.layers} grow {...section('layers', sidebarCopy.layers)}><DocumentLayers readOnly={document.readOnly} /></SidebarSection>
  </SidebarStack></SidebarTabPanel>}{!document.readOnly && pageMenu && <PageContextMenu position={pageMenu} canDelete={pages.length > 1} onRename={() => setRenamingPage(pageMenu.pageId)} onDuplicate={() => duplicatePage(pageMenu.pageId)} onDelete={() => deletePage(pageMenu.pageId)} onClose={() => setPageMenu(null)} />}</Surface>
}

function Canvas({ state, saving, readOnly, following, mobile, panels, onHome }: { state: EditorState; saving: boolean; readOnly: boolean; following: boolean; mobile: boolean; panels: Readonly<{ left: boolean; right: boolean; onToggleLeft: () => void; onToggleRight: () => void }>; onHome?: (() => void) | undefined }) {
  const previewConnecting = Boolean(state.snapshot?.preview.url && !state.previewReady)
  const status = saving ? { label: copy.documentSaving } : previewConnecting ? { label: copy.previewConnecting } : undefined
  return <CanvasWorkspace {...(state.snapshot?.preview.url ? { src: state.snapshot.preview.url } : {})} {...(status ? { status } : {})} readOnly={readOnly} mobile={mobile} panels={following ? undefined : panels} onHome={onHome} ready={state.previewReady} onReady={target => previewConnection.connect(target)} onError={() => previewConnection.disconnect()} onShortcuts={() => store.set({ shortcutOpen: true })} placeholder={<Layout roleName="preview-placeholder"><Message title={state.busy ?? copy.previewUnavailable} body={copy.previewHint} action={!state.snapshot ? <Button variant="outline" disabled={Boolean(state.busy)} onClick={() => void store.open()}>{state.capabilities.openLabel}</Button> : undefined} /></Layout>} />
}

export function inspectorHeaderPresentation(file: DocumentState['file'], selection: readonly string[], pageId: string | null): Readonly<{ title: string; component: boolean }> {
  if (selection.length > 1) return { title: copy.selectionCount(selection.length), component: false }
  if (selection.length === 1 && file) {
    const component = canvasComponentNode(file, selection[0]!)
    return { title: component?.definition.name ?? layerPresentation(file, selection[0]!)?.name ?? copy.inspector, component: Boolean(component) }
  }
  return { title: file?.pages.find(page => page.id === pageId)?.name ?? copy.page, component: false }
}

function Inspector({ document, header, mobile = false }: { document: DocumentState; header: ReactNode; mobile?: boolean }) {
  const modelInstanceRecord = document.selection.length === 1 ? document.file?.componentModel.instances[document.selection[0]!] : undefined
  const modelInstanceComponentId = modelInstanceRecord?.componentId
  const modelDefinition = document.selection.length === 1 && document.file ? canvasComponentNode(document.file, document.selection[0]!)?.definition : undefined
  const presentation = inspectorHeaderPresentation(document.file, document.selection, document.pageId)
  const componentInspector = modelInstanceComponentId
    ? <ComponentModelProperties />
    : modelDefinition ? <ComponentMasterProperties /> : null
  if (mobile) return <>{document.selection.length === 0 ? <PageInspector /> : <>{componentInspector}<SelectionInspector /></>}</>
  return <Surface roleName="right-rail" label={copy.inspector}>{header}<PanelHeader title={presentation.title} {...(presentation.component ? { icon: 'component' as const } : {})} />
    {document.selection.length === 0 ? <PageInspector /> : <>{componentInspector}<SelectionInspector /></>}
  </Surface>
}

function SourceReview({ state, document }: { state: EditorState; document: DocumentState }) {
  const prepared = state.prepared
  return <Surface roleName="review-panel" label={copy.source}><PanelHeader title={copy.source} action={<Button label={copy.close} onClick={() => store.set({ reviewOpen: false })}><Icon name="close" /></Button>} /><Layout roleName="review-content"><Layout roleName="stack">{prepared ? prepared.files.map(file => <Layout key={file.path} roleName="stack"><Text roleName="data">{file.path}</Text><CodeBlock value={file.diff} /></Layout>) : <Text roleName="muted">{copy.noReview}</Text>}</Layout><Layout roleName="stack">{prepared && <><Text roleName="strong">{prepared.scope}</Text><Text>{prepared.summary}</Text><Text roleName="muted">{copy.validation}</Text>{prepared.validation.map(check => <ValuePair key={check.name} label={check.name} value={check.status} />)}<Check label={copy.approved} checked={state.approved} disabled={Boolean(state.busy)} onChange={approved => store.set({ approved })} /><Button variant="primary" disabled={!state.approved || Boolean(state.busy) || document.dirty || document.saving || prepared.validation.some(check => check.status !== 'passed')} onClick={() => void store.save()}>{copy.save}</Button><Button onClick={() => store.set({ prepared: null, approved: false })}>{copy.discard}</Button></>}</Layout></Layout></Surface>
}

function Activity({ state }: { state: EditorState }) {
  const status = state.busy ?? (state.notice === copy.ready ? null : state.notice)
  if (!status && !state.error && !state.snapshot?.conflict && state.snapshot?.preview.status !== 'error') return null
  return <Layout roleName="activity" aria-live="polite">{state.snapshot?.conflict ? <Message danger title={copy.conflict} body={state.snapshot.conflict.message} action={<Button disabled={Boolean(state.busy)} onClick={() => void store.refresh()}>{copy.refresh}</Button>} /> : state.error ? <Message danger title={copy.error} body={state.error} action={<Button disabled={Boolean(state.busy)} onClick={() => void store.refresh()}>{copy.retry}</Button>} /> : state.snapshot?.preview.status === 'error' ? <Message danger title={copy.previewError} body={state.snapshot.preview.diagnostics.join('\n') || copy.previewRetained} /> : <Text roleName="muted">{status}</Text>}</Layout>
}

export type EditorPanelVisibility = Readonly<{ left: boolean; right: boolean }>
const defaultPanelVisibility: EditorPanelVisibility = Object.freeze({ left: true, right: true })

export const toggleEditorPanel = (visibility: EditorPanelVisibility, panel: keyof EditorPanelVisibility): EditorPanelVisibility => ({
  ...visibility,
  [panel]: !visibility[panel],
})

export const editorColumns = (widths: Readonly<{ left: number; right: number }>, readOnly: boolean, following: boolean, visibility: EditorPanelVisibility = defaultPanelVisibility) => {
  if (following) return '0 minmax(0, 1fr) 0'
  const left = visibility.left ? `${widths.left}px` : '0'
  const right = !readOnly && visibility.right ? `${widths.right}px` : '0'
  return `${left} minmax(0, 1fr) ${right}`
}

export function EditorWorkArea({ following, readOnly, mobile = false, visibility = defaultPanelVisibility, columns, library, canvas, inspector, leftResizer, rightResizer }: { following: boolean; readOnly: boolean; mobile?: boolean; visibility?: EditorPanelVisibility; columns: string; library: ReactNode; canvas: ReactNode; inspector: ReactNode; leftResizer: ReactNode; rightResizer: ReactNode }) {
  return <Layout roleName="work-area" data-following={following || undefined} data-read-only={readOnly || undefined} data-mobile={mobile || undefined} data-left-hidden={!visibility.left || undefined} data-right-hidden={!visibility.right || undefined} style={{ gridTemplateColumns: columns }}>{mobile ? canvas : <>{library}{canvas}{!readOnly && inspector}</>}{!mobile && !following && visibility.left && leftResizer}{!mobile && !following && !readOnly && visibility.right && rightResizer}</Layout>
}

export function Editor({ onHome, onPageChange }: { onHome?: () => void; onPageChange?: (pageId: string) => void }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const document = useSyncExternalStore(documentStore.subscribe, documentStore.getShellSnapshot, documentStore.getShellSnapshot)
  const repository = useSyncExternalStore(repositoryConnectionService.subscribe, repositoryConnectionService.getSnapshot, repositoryConnectionService.getSnapshot)
  const followingPresenceId = useSyncExternalStore(collaborationService.subscribeFollowing, collaborationService.getFollowingSnapshot, collaborationService.getFollowingSnapshot)
  const connectedAtoms = connectedRegistryAtoms(repository.connection)
  const atoms = repository.connection ? connectedAtoms : state.snapshot?.atoms ?? []
  const [widths, setWidths] = useState({ left: 280, right: 280 })
  const [panelVisibility, setPanelVisibility] = useState<EditorPanelVisibility>(defaultPanelVisibility)
  const [mobilePanel, setMobilePanel] = useState<EditorMobilePanel>(null)
  const mobile = useSyncExternalStore(mobileViewport.subscribe, mobileViewport.getSnapshot, mobileViewport.getServerSnapshot)
  const following = followingPresenceId !== null
  const effectiveVisibility = mobile ? mobilePanelVisibility(mobilePanel, document.readOnly) : panelVisibility
  const columns = mobile ? 'minmax(0, 1fr)' : editorColumns(widths, document.readOnly, following, panelVisibility)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => editorKeyDown(event)
  const onKeyUp = (event: KeyboardEvent<HTMLDivElement>) => editorKeyUp(event)
  // TODO: Add a source control pane after two-way repository sync has a verified state model.
  const panels = Object.freeze({
    ...effectiveVisibility,
    onToggleLeft: () => { if (mobile) setMobilePanel(current => toggleMobilePanel(current, 'layers')); else setPanelVisibility(current => toggleEditorPanel(current, 'left')) },
    onToggleRight: () => { if (mobile) setMobilePanel(current => toggleMobilePanel(current, 'design')); else setPanelVisibility(current => toggleEditorPanel(current, 'right')) },
  })
  const library = <Library state={state} document={document} atoms={atoms} header={<FileHeader state={state} onHome={onHome} onTogglePanel={panels.onToggleLeft} />} mobile={mobile} onPageChange={onPageChange} />
  const inspector = !document.readOnly ? <Inspector document={document} header={<ActionsHeader state={state} onTogglePanel={panels.onToggleRight} />} mobile={mobile} /> : null
  return <ToastRegion mode={state.mode}><ThemeRoot mode={state.mode} label={copy.title} onKeyDown={onKeyDown} onKeyUp={onKeyUp}><EditorWorkArea following={following} readOnly={document.readOnly} mobile={mobile} visibility={effectiveVisibility} columns={columns} library={library} canvas={<Canvas state={state} saving={document.saving} readOnly={document.readOnly} following={following} mobile={mobile} panels={panels} onHome={onHome} />} inspector={inspector} leftResizer={<PanelResizer label={sidebarCopy.resizeLeft} edge="left" offset={widths.left} value={widths.left} min={200} max={480} onChange={left => setWidths(current => ({ ...current, left }))} />} rightResizer={<PanelResizer label={sidebarCopy.resizeRight} edge="right" offset={widths.right} value={widths.right} min={240} max={480} onChange={right => setWidths(current => ({ ...current, right }))} />} />{mobile && <><MobileSheet open={mobilePanel === 'layers'} mode={state.mode} title={sidebarCopy.layers} closeLabel={`${copy.close} ${sidebarCopy.layers}`} onOpenChange={open => { if (!open) setMobilePanel(null) }}>{library}</MobileSheet>{!document.readOnly && <MobileSheet open={mobilePanel === 'design'} mode={state.mode} title={copy.properties} closeLabel={`${copy.close} ${copy.properties}`} onOpenChange={open => { if (!open) setMobilePanel(null) }}>{inspector}</MobileSheet>}</>}{state.reviewOpen && state.prepared && !document.readOnly && <SourceReview state={state} document={document} />}<Activity state={state} />{!document.readOnly && <><ComponentCreationDialog /><ShareDialog state={state} /></>}<Popup mode={state.mode} closeLabel={copy.close} open={state.shortcutOpen} onOpenChange={shortcutOpen => store.set({ shortcutOpen })} title={copy.shortcutTitle}>{copy.shortcutRows.map(([label, value]) => <ValuePair key={label} label={label} value={value} />)}</Popup></ThemeRoot></ToastRegion>
}

