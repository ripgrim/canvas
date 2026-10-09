import { useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { Button, Check, CodeBlock, Disclosure, Icon, Layout, Popup, ScopePicker, Surface, Text, ThemeRoot } from '../../design-system/atoms'
import { InspectorField, Message, PanelHeader, ValuePair } from '../../design-system/molecules'
import { editorCopy as copy } from './copy'
import { editorStore as store } from './store'
import type { EditorState } from './store'
import { previewConnection } from './preview-service'
import { documentStore } from './document-store'
import type { DocumentState } from './document-store'
import { CanvasWorkspace } from './CanvasWorkspace'
import { activeDesignTheme, designThemeOptions } from './design-theme'
import { DocumentLayers } from './DocumentLayers'
import { ComponentLibrary } from './ComponentLibrary'
import { ComponentProperties } from './ComponentProperties'
import { CodeTools } from './CodeTools'
import { editorKeyDown, editorKeyUp } from './keyboard-service'
import { ColorPicker } from '../../design-system/color-picker'
import { PageInspector, SelectionInspector } from './InspectorPanels'
import { SidebarAction, SidebarPageRow, SidebarSection, SidebarStack, SidebarTabPanel, SidebarTabs } from '../../design-system/sidebar-atoms'
import { ThemePanel } from './ThemePanel'
import { sidebarCopy } from './sidebar-copy'
import { focusSequence, sidebarViewFor, themeFocus } from './theme-focus'
import type { SidebarChoice } from './theme-focus'
import { HeaderIconButton, PanelHeaderBar, PanelHeaderTitle, PanelResizer, PanelToolbar } from '../../design-system/shell-atoms'
import { CompLogo } from '../../design-system/brand'

function FileHeader({ state, onHome }: { state: EditorState; onHome?: (() => void) | undefined }) {
  const name = state.snapshot?.composition.name ?? copy.file
  return <PanelHeaderBar><HeaderIconButton label={copy.files} glyph={<CompLogo height={16} />} disabled={!onHome || Boolean(state.busy)} onClick={() => onHome?.()} /><PanelHeaderTitle title={name}>{name}</PanelHeaderTitle></PanelHeaderBar>
}

function ActionsHeader({ state }: { state: EditorState }) {
  const reloadLabel = state.snapshot ? state.capabilities.runtime === 'browser' ? copy.reloadDraft : copy.refresh : state.capabilities.openLabel
  return <PanelToolbar label={copy.panelActions}><HeaderIconButton compact label={reloadLabel} icon={state.snapshot ? 'refresh' : 'plus'} disabled={Boolean(state.busy)} onClick={() => void (state.snapshot ? store.refresh() : store.open())} /><HeaderIconButton compact label={state.mode === 'light' ? copy.themeDark : copy.themeLight} icon={state.mode === 'light' ? 'moon' : 'sun'} onClick={() => store.setAppearance(state.mode === 'light' ? 'dark' : 'light')} /><HeaderIconButton compact label={copy.review} icon="code" pressed={state.reviewOpen} onClick={() => store.set({ reviewOpen: !state.reviewOpen })} /><Button variant="secondary" onClick={() => store.set({ shareOpen: true })}>{copy.share}</Button></PanelToolbar>
}

type SidebarKey = 'pages' | 'layers' | 'components'
type SidebarView = 'design' | 'theme'
const sidebarViews = [{ value: 'design', label: sidebarCopy.design }, { value: 'theme', label: sidebarCopy.theme }] as const satisfies readonly { value: SidebarView; label: string }[]

function Library({ state, document, header, onPageChange }: { state: EditorState; document: DocumentState; header: ReactNode; onPageChange?: ((pageId: string) => void) | undefined }) {
  const pages = document.file?.pages ?? []
  const openPage = (pageId: string) => { if (onPageChange) onPageChange(pageId); else documentStore.setPage(pageId) }
  const addPage = () => { const pageId = documentStore.commands.createPage({ activate: !onPageChange }); if (pageId && onPageChange) onPageChange(pageId) }
  const [open, setOpen] = useState<Record<SidebarKey, boolean>>({ pages: true, layers: true, components: false })
  // Edit token requests (theme-focus) open the Theme tab; a later manual choice takes over until the next request.
  const focus = useSyncExternalStore(themeFocus.subscribe, themeFocus.getSnapshot, themeFocus.getSnapshot)
  const [choice, setChoice] = useState<SidebarChoice>(() => ({ view: 'design', at: focusSequence(themeFocus.getSnapshot()) }))
  const view: SidebarView = sidebarViewFor(focus, choice)
  const setView = (next: SidebarView) => setChoice({ view: next, at: focusSequence(themeFocus.getSnapshot()) })
  const section = (key: SidebarKey, title: string, count?: number) => ({ expanded: open[key], toggleLabel: open[key] ? sidebarCopy.collapse(title, count) : sidebarCopy.expand(title, count), onToggle: () => setOpen(current => ({ ...current, [key]: !current[key] })) })
  return <Surface roleName="left-rail" label={sidebarCopy.label}>{header}<SidebarTabs label={sidebarCopy.views} idPrefix="sidebar" value={view} options={sidebarViews} onChange={setView} />
    {view === 'theme' ? <SidebarTabPanel idPrefix="sidebar" value="theme"><ThemePanel /></SidebarTabPanel> : <SidebarTabPanel idPrefix="sidebar" value="design"><SidebarStack>
    <SidebarSection id="pages" title={sidebarCopy.pages} count={pages.length} {...section('pages', sidebarCopy.pages, pages.length)} actions={<SidebarAction label={sidebarCopy.addPage} icon="plus" disabled={!document.file || document.blocked || Boolean(state.busy)} onSelect={addPage} />}>{pages.map(page => <SidebarPageRow key={page.id} pageId={page.id} name={page.name} selected={page.id === document.pageId} onSelect={() => openPage(page.id)} />)}</SidebarSection>
    <SidebarSection id="layers" title={sidebarCopy.layers} grow {...section('layers', sidebarCopy.layers)}><DocumentLayers /></SidebarSection>
    <SidebarSection id="components" title={sidebarCopy.components} {...section('components', sidebarCopy.components)}><ComponentLibrary atoms={state.snapshot?.atoms ?? []} /></SidebarSection>
  </SidebarStack></SidebarTabPanel>}</Surface>
}

function Canvas({ state, saving }: { state: EditorState; saving: boolean }) {
  const designTheme = activeDesignTheme(state.snapshot, state.previewThemeId)
  const status = saving ? { label: copy.documentSaving } : state.compositionPreview ? { label: copy.compositionStatus, description: copy.compositionHint } : undefined
  return <CanvasWorkspace {...(state.snapshot?.preview.url ? { src: state.snapshot.preview.url } : {})} {...(designTheme ? { theme: { value: designTheme.id, options: designThemeOptions(state.snapshot), onChange: (themeId: string) => void store.setPreviewTheme(themeId) } } : {})} {...(status ? { status } : {})} ready={state.previewReady} onReady={target => previewConnection.connect(target)} onError={() => store.set({ previewReady: false })} onShortcuts={() => store.set({ shortcutOpen: true })} placeholder={<Layout roleName="preview-placeholder"><Message title={state.busy ?? copy.previewUnavailable} body={copy.previewHint} action={!state.snapshot ? <Button variant="outline" disabled={Boolean(state.busy)} onClick={() => void store.open()}>{state.capabilities.openLabel}</Button> : undefined} /></Layout>} />
}

function Inspector({ state, document, header }: { state: EditorState; document: DocumentState; header: ReactNode }) {
  const snapshot = state.snapshot
  const selectedChild = snapshot?.composition.children.find(child => child.id === state.selected)
  const selectedNode = document.file?.nodes[state.selected ?? '']
  const selectedComponentId = selectedNode?.type === 'component' ? selectedNode.componentId : undefined
  const selected = snapshot?.atoms.find(atom => atom.componentId === (selectedComponentId ?? selectedChild?.componentId ?? state.selected))
  const isSharedLabel = selected?.exportName === 'Label' && selected.status === 'bound'
  const sourceAllowed = state.capabilities.sourceWrites.available
  const canPrepare = sourceAllowed && Boolean(snapshot) && !snapshot?.conflict && !state.busy && !document.dirty && !document.saving && (state.scope === 'Token' || state.scope === 'Shared component' && isSharedLabel)
  // Only reasons an action is unavailable stay visible; scope explanations move to the Review button tooltip.
  const unavailable = !sourceAllowed ? state.capabilities.sourceWrites.reason : state.scope === 'Shared component' && !isSharedLabel ? copy.selectLabel : null
  const scopeHint = state.scope === 'Instance' ? copy.instanceHint : state.scope === 'Token' ? copy.tokenHint : isSharedLabel ? copy.sharedHint : copy.selectLabel
  const title = document.selection.length > 1 ? copy.selectionCount(document.selection.length) : document.selection.length ? selected?.name ?? copy.inspector : document.file?.pages.find(page => page.id === document.pageId)?.name ?? copy.page
  return <Surface roleName="right-rail" label={copy.inspector}>{header}<PanelHeader title={title} />
    {document.selection.length === 0 ? <PageInspector /> : <><SelectionInspector /><ComponentProperties atoms={snapshot?.atoms ?? []} /></>}
    <Disclosure title={copy.sourceTokens} open={false}>{snapshot?.tokens.length ? snapshot.tokens.map(token => <ValuePair key={token.path + ':' + token.selector + ':' + token.name} label={token.selector === ':root' ? token.name : `${token.name} ${token.selector}`} value={token.value} />) : <Text roleName="muted">{copy.noSourceTokens}</Text>}</Disclosure>
    <Disclosure title={copy.sourceEditing} open={false}><ScopePicker label={copy.scope} value={state.scope} values={copy.scopes} disabled={!sourceAllowed || Boolean(state.busy)} onChange={scope => store.edit({ scope })} />{unavailable && <Text roleName="muted">{unavailable}</Text>}
      {sourceAllowed && state.scope === 'Shared component' && isSharedLabel && <InspectorField id="label-padding" label={copy.padding} value={state.padding} onChange={padding => store.edit({ padding })} />}
      {sourceAllowed && state.scope === 'Token' && <ColorPicker label={copy.token} value={state.token} mode={state.mode} allowAlpha={false} onChange={token => store.edit({ token })} />}
      <Button variant="outline" title={scopeHint} disabled={!canPrepare} onClick={() => void store.prepare()}>{copy.review}</Button>
      <Disclosure title={copy.bound} open={false}>{selected ? <><Text roleName="data">{selected.path}</Text><ValuePair label={copy.exportName} value={selected.exportName} /><ValuePair label={copy.status} value={selected.status} /><Text roleName="small">{selected.componentId}</Text></> : <Text roleName="muted">{copy.noSelection}</Text>}</Disclosure>
    </Disclosure>
    <Disclosure title={copy.promotion} open={false}><InspectorField id="component-name" label={copy.componentName} value={state.componentName} onChange={componentName => store.edit({ componentName })} />{document.dirty && <Text roleName="muted">{copy.compositionPromotionHint}</Text>}<Button variant="outline" title={copy.promotionHint} disabled={!sourceAllowed || !snapshot || Boolean(state.busy) || document.dirty || document.saving || Boolean(snapshot.conflict)} onClick={() => void store.promote()}>{copy.promotion}</Button></Disclosure>
    <CodeTools />
    <Disclosure title={copy.history} open={false}>{snapshot?.sourceHistory.slice(-1).map(entry => <Layout key={entry.transactionId} roleName="stack"><Text>{entry.summary}</Text><Button variant="outline" disabled={Boolean(state.busy) || document.dirty || document.saving || Boolean(snapshot.conflict)} onClick={() => void store.prepareSourceHistory(entry.action, entry.transactionId)}>{entry.action === 'undo' ? copy.sourceUndo : copy.sourceRedo}</Button></Layout>)}{!snapshot?.sourceHistory.length && <Text roleName="muted">{copy.noHistory}</Text>}</Disclosure>
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

export function Editor({ onHome, onPageChange }: { onHome?: () => void; onPageChange?: (pageId: string) => void }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const document = useSyncExternalStore(documentStore.subscribe, documentStore.getViewSnapshot, documentStore.getViewSnapshot)
  const [widths, setWidths] = useState({ left: 280, right: 280 })
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => editorKeyDown(event)
  const onKeyUp = (event: KeyboardEvent<HTMLDivElement>) => editorKeyUp(event)
  // TODO: Add a source control pane after two-way repository sync has a verified state model.
  return <ThemeRoot mode={state.mode} label={copy.title} onKeyDown={onKeyDown} onKeyUp={onKeyUp}><Layout roleName="work-area" style={{ gridTemplateColumns: `${widths.left}px minmax(0, 1fr) ${widths.right}px` }}><Library state={state} document={document} header={<FileHeader state={state} onHome={onHome} />} onPageChange={onPageChange} /><Canvas state={state} saving={document.saving} /><Inspector state={state} document={document} header={<ActionsHeader state={state} />} /><PanelResizer label={sidebarCopy.resizeLeft} edge="left" offset={widths.left} value={widths.left} min={200} max={480} onChange={left => setWidths(current => ({ ...current, left }))} /><PanelResizer label={sidebarCopy.resizeRight} edge="right" offset={widths.right} value={widths.right} min={240} max={480} onChange={right => setWidths(current => ({ ...current, right }))} /></Layout>{state.reviewOpen && <SourceReview state={state} document={document} />}<Activity state={state} /><Popup mode={state.mode} closeLabel={copy.close} open={state.shareOpen} onOpenChange={shareOpen => store.set({ shareOpen })} title={copy.share}><Text>{copy.shareUnavailable}</Text></Popup><Popup mode={state.mode} closeLabel={copy.close} open={state.shortcutOpen} onOpenChange={shortcutOpen => store.set({ shortcutOpen })} title={copy.shortcutTitle}>{copy.shortcutRows.map(([label, value]) => <ValuePair key={label} label={label} value={value} />)}</Popup></ThemeRoot>
}




