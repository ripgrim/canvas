import { Button, Text } from '../../design-system/atoms'
import { InspectorField } from '../../design-system/molecules'
import type { DocumentState } from './document-store'
import type { EditorState } from './store'
import { editorStore as store } from './store'
import { editorCopy as copy } from './copy'

type PromotionState = Pick<EditorState, 'busy' | 'capabilities' | 'componentName' | 'snapshot'>
type PromotionDocument = Pick<DocumentState, 'dirty' | 'saving'>

export function componentPromotionAvailability(state: PromotionState, document: PromotionDocument): { disabled: boolean; reason: string | null } {
  if (!state.capabilities.sourceWrites.available) return { disabled: true, reason: state.capabilities.sourceWrites.reason }
  if (!state.snapshot) return { disabled: true, reason: copy.initial }
  if (state.snapshot.conflict) return { disabled: true, reason: copy.conflictHint }
  if (document.dirty || document.saving) return { disabled: true, reason: copy.promotionSaveDraft }
  if (state.busy) return { disabled: true, reason: state.busy }
  return { disabled: false, reason: null }
}

/** Repository promotion only prepares a source patch. Review approval and Save remain separate explicit actions. */
export function ComponentPromotion({ state, document }: { state: PromotionState; document: PromotionDocument }) {
  const availability = componentPromotionAvailability(state, document)
  return <>
    <InspectorField id="component-name" label={copy.componentName} value={state.componentName} onChange={componentName => store.edit({ componentName })} />
    <Text roleName="muted">{copy.compositionPromotionHint}</Text>
    {availability.reason && <Text roleName="muted">{availability.reason}</Text>}
    <Button variant="outline" title={availability.reason ?? copy.promotionHint} disabled={availability.disabled} onClick={() => void store.promote()}>{copy.promotionReview}</Button>
  </>
}
